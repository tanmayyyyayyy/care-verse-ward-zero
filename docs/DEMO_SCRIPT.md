# Demo video script (about 3 minutes)

**Flow to show:** Sensor simulation → Platform → AI risk detection → Alert → Caregiver response.

**Before recording:** start the stack, log in as `doctor@careverse.com` in one window and `caregiver@careverse.com` in a private window. Optionally set `VITALS_STALE_SECONDS=30` so the stale state appears quickly (the Docker setup already does).

| Time | On screen | Say |
|---|---|---|
| 0:00 | Login, then the dashboard with the five-stage strip | "A bedroom as a small hospital ward. Every patient moves through Sense, Understand, Predict, Alert, Respond, and this strip shows the live state of each stage." |
| 0:15 | **Caregivers and Home Hub**: pick Patient B, scenario *Stable*, **Start sensor stream** | "These are synthetic bedroom sensors. Readings go through a home hub into the same pipeline a real device would use." |
| 0:30 | **Home Care Intelligence**: ward table, select Patient B | "Everyone's risk, early-warning score, sensor state and outlook in one place." |
| 0:40 | Switch scenario to *Slow decline* | "Now the patient slowly worsens. Nothing has crossed an emergency threshold yet." |
| 1:00 | Outlook card shows the forecast, chart and drivers | "The platform projects 24 and 48 hours ahead if the trend continues, and says which vitals drive it. It is labelled experimental and gives a confidence level." |
| 1:15 | Alert appears (forecast, then threshold alerts) | "An alert is raised early, with an explanation, not just a number." |
| 1:25 | Add caregiver note: *Seems confused and drowsy since lunch.* | "Caregivers add context. New confusion raises the score and creates an urgent alert. A note like 'no chest pain' is understood as negative, and reassuring notes never lower risk." |
| 1:50 | **Why this risk** card | "Every point is traceable: this vital added 3, this note raised the level." |
| 2:00 | Home Hub: **Cut the link**, send readings | "Resilience: the connection drops. Readings are held on the hub, nothing is lost." |
| 2:15 | **Reconnect and replay** | "On reconnect they replay in order, de-duplicated, and timestamps are preserved." |
| 2:25 | Caregiver window: **Check in**, open Alerts, **Acknowledge** | "A caregiver checks in and acknowledges. The response is timed and audited." |
| 2:40 | Caregivers page: median response, roster, coverage | "We measure who is present and how fast they respond. If nobody is on duty while alerts wait, the platform escalates beyond the care team." |
| 2:55 | Safety notice | "Synthetic data, experimental, supports a caregiver and never replaces one." |

**Tips:** do the *Slow decline* stream for at least 8 to 10 readings (about 30 seconds) before showing the outlook. Use *Sudden drop* if you want an immediate high-risk alert.
