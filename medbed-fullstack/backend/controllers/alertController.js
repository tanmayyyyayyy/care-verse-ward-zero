const { Alert } = require('../models/index');
const { AppError } = require('../middleware/errorHandler');
const { recordAudit } = require('../services/auditService');
const { ACTIVE_ALERT_FILTER } = require('../services/alertService');
const { ACK_TIMEOUT_SECONDS } = require('../services/patientMonitorService');

const decorateAlert = (alert, now = Date.now()) => {
  const data = alert.toObject ? alert.toObject() : { ...alert };
  const createdAt = new Date(data.createdAt).getTime();
  const dueAt = createdAt + ACK_TIMEOUT_SECONDS * 1000;
  return {
    ...data,
    ageSeconds: Math.max(0, Math.floor((now - createdAt) / 1000)),
    isOverdue:
      !data.isAcknowledged &&
      !data.isDismissed &&
      !data.resolvedAt &&
      now >= dueAt,
    acknowledgmentDueAt: new Date(dueAt).toISOString(),
  };
};

exports.getAllAlerts = async (req, res, next) => {
  try {
    const { severity, type, acknowledged, status, patient } = req.query;
    const filter = {};

    if (severity) filter.severity = severity;
    if (type) filter.type = type;
    if (patient) filter.patient = patient;

    if (acknowledged !== undefined) {
      filter.isAcknowledged = acknowledged === 'true';
    }

    if (status === 'active') Object.assign(filter, ACTIVE_ALERT_FILTER);
    else if (status === 'acknowledged') filter.isAcknowledged = true;
    else if (status === 'resolved') filter.resolvedAt = { $ne: null };
    else if (status === 'dismissed') filter.isDismissed = true;

    const alerts = await Alert.find(filter)
      .populate('patient', 'name patientId ward bed')
      .populate('transfer', 'transferId fromWard toWard')
      .populate('assignedTo', 'name role')
      .populate('acknowledgedBy', 'name role')
      .sort({ createdAt: -1 })
      .limit(200);

    const now = Date.now();
    res.status(200).json({
      success: true,
      count: alerts.length,
      data: alerts.map((alert) => decorateAlert(alert, now)),
    });
  } catch (error) {
    next(error);
  }
};

exports.acknowledgeAlert = async (req, res, next) => {
  try {
    const alert = await Alert.findById(req.params.id);
    if (!alert) return next(new AppError('Alert not found.', 404));

    if (alert.isDismissed || alert.resolvedAt) {
      return next(new AppError('Resolved or dismissed alerts cannot be acknowledged.', 409));
    }

    if (!alert.isAcknowledged) {
      const now = new Date();
      alert.isAcknowledged = true;
      alert.acknowledgedBy = req.user._id;
      alert.acknowledgedAt = now;
      alert.acknowledgmentLatencyMs = Math.max(
        0,
        now.getTime() - new Date(alert.createdAt).getTime()
      );
      alert.acknowledgmentNote = String(req.body.note || '').trim().slice(0, 500);
      await alert.save();

      await recordAudit({
        action: 'alert_acknowledged',
        entityType: 'Alert',
        entityId: alert._id,
        patient: alert.patient,
        actor: req.user._id,
        actorRole: req.user.role,
        metadata: {
          latencyMs: alert.acknowledgmentLatencyMs,
          note: alert.acknowledgmentNote,
        },
      });

      const io = req.app.get('io');
      if (io) {
        io.emit('alert:acknowledged', {
          alertId: alert._id,
          patientId: alert.patient,
          acknowledgedBy: {
            id: req.user._id,
            name: req.user.name,
            role: req.user.role,
          },
          acknowledgedAt: alert.acknowledgedAt,
          acknowledgmentLatencyMs: alert.acknowledgmentLatencyMs,
        });
      }
    }

    res.status(200).json({ success: true, data: decorateAlert(alert) });
  } catch (error) {
    next(error);
  }
};

exports.dismissAlert = async (req, res, next) => {
  try {
    const reason = String(req.body.reason || '').trim();
    if (reason.length < 3) {
      return next(new AppError('A dismissal reason of at least 3 characters is required.', 400));
    }

    const alert = await Alert.findById(req.params.id);
    if (!alert) return next(new AppError('Alert not found.', 404));
    if (alert.resolvedAt) {
      return next(new AppError('Resolved alerts cannot be dismissed.', 409));
    }

    if (!alert.isDismissed) {
      alert.isDismissed = true;
      alert.dismissedBy = req.user._id;
      alert.dismissedAt = new Date();
      alert.dismissReason = reason.slice(0, 500);
      alert.dedupKey = undefined;
      await alert.save();

      await recordAudit({
        action: 'alert_dismissed',
        entityType: 'Alert',
        entityId: alert._id,
        patient: alert.patient,
        actor: req.user._id,
        actorRole: req.user.role,
        metadata: { reason: alert.dismissReason },
      });

      const io = req.app.get('io');
      if (io) {
        io.emit('alert:dismissed', {
          alertId: alert._id,
          patientId: alert.patient,
          reason: alert.dismissReason,
          dismissedBy: { id: req.user._id, name: req.user.name, role: req.user.role },
        });
      }
    }

    res.status(200).json({ success: true, data: decorateAlert(alert) });
  } catch (error) {
    next(error);
  }
};

exports.getAlertSummary = async (req, res, next) => {
  try {
    const active = { ...ACTIVE_ALERT_FILTER };
    const now = Date.now();

    const [
      critical,
      warning,
      info,
      activeUnacknowledged,
      activeAcknowledged,
      resolved,
      avgAck,
    ] = await Promise.all([
      Alert.countDocuments({ ...active, severity: 'critical' }),
      Alert.countDocuments({ ...active, severity: 'warning' }),
      Alert.countDocuments({ ...active, severity: 'info' }),
      Alert.countDocuments({ ...active, isAcknowledged: false }),
      Alert.countDocuments({ ...active, isAcknowledged: true }),
      Alert.countDocuments({ resolvedAt: { $ne: null } }),
      Alert.aggregate([
        { $match: { acknowledgmentLatencyMs: { $ne: null } } },
        { $group: { _id: null, average: { $avg: '$acknowledgmentLatencyMs' } } },
      ]),
    ]);

    const overdue = await Alert.countDocuments({
      ...active,
      isAcknowledged: false,
      createdAt: { $lte: new Date(now - ACK_TIMEOUT_SECONDS * 1000) },
    });

    res.status(200).json({
      success: true,
      data: {
        critical,
        warning,
        info,
        activeUnacknowledged,
        activeAcknowledged,
        overdue,
        resolved,
        averageAcknowledgmentMs: avgAck[0]?.average
          ? Math.round(avgAck[0].average)
          : null,
        acknowledgmentTimeoutSeconds: ACK_TIMEOUT_SECONDS,
      },
    });
  } catch (error) {
    next(error);
  }
};
