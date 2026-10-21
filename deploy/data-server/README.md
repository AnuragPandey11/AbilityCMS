# Data server: broker watchdog and update policy

Two settings on the data server (`solarcms-data`), added after the outage of
21 Oct 2026.

## What happened

At 06:04 UTC (11:34 IST), Ubuntu's daily automatic update (`apt-daily-upgrade`,
which runs `unattended-upgrades`) installed eight routine packages. Because a
shared library (`liblzma5`) changed, it then restarted the services that use it,
including **PostgreSQL** and **systemd-networkd**:

- The database restart cut every database connection. The four workers on the
  app server (ingest, alarm, health sweeper, scheduler) each hold a leader lock
  on one, so they stopped themselves and ECS restarted them. That part recovered
  by itself.
- The network restart also touched the broker's Docker network. A broker
  connection came back "connected but silent", and no data reached production
  for eight hours, until EMQX was restarted by hand.

The weekly patch window (AWS `AWS-RunPatchBaseline`, Mondays 03:00 IST,
`deploy/terraform/monitoring.tf`) already installs updates. The daily run was a
second, unplanned one at a random time in the working day.

## 1. Daily automatic updates are off

Updates still arrive every Monday at 03:00 IST through the patch window.

```
systemctl disable --now apt-daily-upgrade.timer unattended-upgrades.service
```

`apt-daily.timer` stays on: it only refreshes the package lists and installs
nothing.

What this changes, and what it leaves to a person:

- **Security fixes arrive within a week instead of within a day.** The risk is
  low: from the internet the data server answers only on 8883 (the broker, TLS
  and a password) and 80 (certificate renewal). PostgreSQL and port 1883 are
  open to the app server alone (`network.tf`).
- **Check the Monday job really runs.** Until 21 Oct the daily job did the
  work, so a failing weekly one would have gone unnoticed. Systems Manager →
  State Manager → `solarcms-data-patching` → Execution history: the last Monday
  should read Success. Look again after any change to the server or its IAM
  role.
- **Reboot about once a month, at night.** The patch window never reboots this
  server (`RebootOption = NoReboot`, `monitoring.tf`), so a new kernel waits for
  a reboot, as it did before. If `/var/run/reboot-required` exists, reboot it
  at a quiet time: EC2 → solarcms-data → Instance state → Reboot. The broker
  and database are down for 2 to 3 minutes, and everything starts again by
  itself, the watchdog included.
- **An urgent fix need not wait for Monday.** Run
  `apt-get update && apt-get upgrade -y` at a quiet time. It restarts what it
  must, as the Monday job does, and the watchdog covers the broker.
- The Monday job itself can restart PostgreSQL and the network service, as the
  daily one did. At 03:00 IST that matters far less, and the watchdog repairs
  the broker within about six minutes.

## 2. The broker watchdog

`solarcms-broker-watchdog` runs every minute from a systemd timer. When
production has stored no message for 5 minutes, it restarts EMQX, but only if
all of these hold:

- Ability's broker is publishing live messages. Retained messages don't count.
- Ingest is connected to our broker.
- The watchdog hasn't restarted EMQX in the last 30 minutes.

Otherwise it leaves the broker alone, because a restart would either not help
or would throw away messages EMQX is holding for ingest. That makes a Monday
patch window that restarts PostgreSQL heal itself within about six minutes.

Install it, as root on the data server. `NEEDRESTART_SUSPEND=1` stops the
package install from restarting services, which is what caused the outage:

```
NEEDRESTART_SUSPEND=1 apt-get update -qq
NEEDRESTART_SUSPEND=1 DEBIAN_FRONTEND=noninteractive apt-get install -y -qq mosquitto-clients
B=https://raw.githubusercontent.com/AnuragPandey11/AbilityCMS/main/deploy/data-server
curl -fsSL "$B/solarcms-broker-watchdog" -o /usr/local/sbin/solarcms-broker-watchdog
chmod 755 /usr/local/sbin/solarcms-broker-watchdog
curl -fsSL "$B/solarcms-broker-watchdog.service" -o /etc/systemd/system/solarcms-broker-watchdog.service
curl -fsSL "$B/solarcms-broker-watchdog.timer" -o /etc/systemd/system/solarcms-broker-watchdog.timer
systemctl daemon-reload
systemctl enable --now solarcms-broker-watchdog.timer
```

To see what it decided (it prints nothing while data is flowing):

```
journalctl -u solarcms-broker-watchdog --no-pager -n 20
```

Settings are overridden in `/etc/default/solarcms-broker-watchdog` (for example
`SILENT_AFTER_S=600`). Once Ability publishes straight to our broker (runbook
stage 13), put `UPSTREAM_HOST=` there, empty, so it no longer checks the copy's
source.

⚠ The watchdog is a safety net, not the fix for the copy itself. Stage 13
removes the copy, and Ability's sender keeps readings while the connection is
down, so an outage on our side then loses nothing.
