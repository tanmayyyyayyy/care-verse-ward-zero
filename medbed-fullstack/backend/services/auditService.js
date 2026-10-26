const mongoose = require('mongoose');
const { AuditLog } = require('../models/index');

const recordAudit = async ({
  action,
  entityType,
  entityId = null,
  patient = null,
  actor = null,
  actorRole = '',
  metadata = {},
}) => {
  if (mongoose.connection.readyState !== 1) {
    return null;
  }
  try {
    return await AuditLog.create({
      action,
      entityType,
      entityId,
      patient,
      actor,
      actorRole,
      metadata,
    });
  } catch (error) {
    console.error('Audit log write failed:', error.message);
    return null;
  }
};

module.exports = { recordAudit };
