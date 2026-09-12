"""All SQLAlchemy models. Importing this module registers every table on Base."""

from solarcms.db.base import Base
from solarcms.db.models.alarming import (
    Alarm,
    AlarmRule,
    EscalationPolicy,
    EscalationStep,
    IncidentSnapshot,
    NotificationLog,
    NotificationSubscription,
)
from solarcms.db.models.assets import (
    Block,
    BrokerCredential,
    Device,
    DeviceTagBinding,
    Plant,
    Region,
    TopicPatternRow,
)
from solarcms.db.models.audit import AuditLog
from solarcms.db.models.catalog import DeviceModel, DeviceModelTag, DeviceType, Tag
from solarcms.db.models.health import DeviceHealth, DeviceHealthEvent
from solarcms.db.models.identity import (
    Client,
    Dashboard,
    Membership,
    Permission,
    Role,
    RolePermission,
    User,
    UserDashboardAccess,
    UserPlantAccess,
)
from solarcms.db.models.reporting import ReportDefinition, ReportRun, ReportSchedule
from solarcms.db.models.telemetry import MqttRaw, Reading

__all__ = [
    "Alarm", "AlarmRule", "AuditLog", "Base", "Block", "BrokerCredential", "Client",
    "Dashboard", "Device", "DeviceHealth", "DeviceHealthEvent", "DeviceModel",
    "DeviceModelTag", "DeviceTagBinding", "DeviceType", "EscalationPolicy",
    "EscalationStep", "IncidentSnapshot", "Membership", "MqttRaw", "NotificationLog",
    "NotificationSubscription", "Permission", "Plant", "Reading", "Region",
    "ReportDefinition", "ReportRun", "ReportSchedule", "Role", "RolePermission", "Tag",
    "TopicPatternRow", "User", "UserDashboardAccess", "UserPlantAccess",
]
