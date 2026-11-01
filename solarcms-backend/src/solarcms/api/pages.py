"""Which ticked tabs a write route needs — dimension A-3 on admin pages (migration 0046).

A route passes if the User has **any** of its tabs: several screens call the
same route, and each must keep working for whoever may open it. Built from
the routes' callers in the frontend (`api/endpoints/*` and who imports them);
a screen that starts calling one of these routes belongs in its list.

Every guard here sits beside the route's `require_permission`, never instead
of it: a tick never grants a permission. Reads are guarded by permission
alone, because the same data fills screens a User may well have.
"""

from __future__ import annotations

from fastapi import Depends

from solarcms.api.deps import require_page

PLANT_SETUP = "admin_plant_setup"
ONBOARDING = "admin_onboarding"
WIRING = "admin_hierarchy"
TAG_MAPPING = "admin_bindings"
DATA_ISSUES = "admin_data_issues"
ALARM_RULES = "admin_alarm_rules"

#: Alarm Rules, read and written.
ALARM_RULES_PAGE = Depends(require_page(ALARM_RULES))
#: Data Issues and its acknowledgements.
DATA_ISSUES_PAGE = Depends(require_page(DATA_ISSUES))
#: Registering a Device: Plants & Devices, Onboarding, a Data Issues fix.
DEVICE_CREATE = Depends(require_page(PLANT_SETUP, ONBOARDING, DATA_ISSUES))
DEVICE_IMPORT = Depends(require_page(ONBOARDING, PLANT_SETUP))
DEVICE_DELETE = Depends(require_page(PLANT_SETUP))
#: A Device's settings are edited from five pages, and its sizes from Sizes &
#: tariff on Inverter Monitoring.
DEVICE_EDIT = Depends(require_page(
    PLANT_SETUP, ONBOARDING, WIRING, TAG_MAPPING, DATA_ISSUES, "inverter_monitoring"))
DEVICE_CREDENTIAL = Depends(require_page(PLANT_SETUP, ONBOARDING))
TOPIC_ATTACH = Depends(require_page(PLANT_SETUP, DATA_ISSUES))
TOPIC_DETACH = Depends(require_page(PLANT_SETUP))
#: Bindings: Tag Mapping, and one binding at a time from a Data Issues fix or
#: from Plants & Devices when it attaches a string topic (`admin/stringTopics.ts`).
BINDINGS_REPLACE = Depends(require_page(TAG_MAPPING))
BINDING_EDIT = Depends(require_page(TAG_MAPPING, DATA_ISSUES, PLANT_SETUP))
MAINTENANCE = Depends(require_page(PLANT_SETUP))
COLLECTOR_EDGE = Depends(require_page(WIRING, PLANT_SETUP))
PLANT_CREATE = Depends(require_page(PLANT_SETUP, ONBOARDING))
#: The Plant's tariff is set from Sizes & tariff; its capacity from a Data Issues fix.
PLANT_EDIT = Depends(require_page(PLANT_SETUP, DATA_ISSUES, "inverter_monitoring"))
#: The status control sits on Single Plant as well as Plants & Devices.
PLANT_STATUS = Depends(require_page(PLANT_SETUP, ONBOARDING, "single_plant"))
BLOCK_CREATE = Depends(require_page(ONBOARDING, PLANT_SETUP))
BLOCK_EDIT = Depends(require_page(PLANT_SETUP))
#: Status meanings: Inverter Monitoring, the Inverter view and the Device
#: inspector, which opens from Single Plant, the SLD and Wiring & Diagram.
STATUS_MEANINGS = Depends(require_page(
    "inverter_monitoring", "single_plant", "sld", WIRING, TAG_MAPPING))
