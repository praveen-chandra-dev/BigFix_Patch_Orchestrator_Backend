BigFix Patch Orchestrator — Backend

Node/Express API that talks to HCL BigFix and ServiceNow to power the Patch Orchestrator frontend.
It executes baseline actions, fetches sandbox results, computes health KPIs from session relevance, validates ServiceNow CHG numbers, and (optionally) emails status.

✨ Features

Trigger BigFix actions for a baseline against a computer group

Fetch sandbox results and expose success/total with table rows

Session Relevance endpoint for Critical Health (RAM/CPU/Disk)

Total computers from BigFix for KPI math

ServiceNow CHG validation (must exist and be in Implement state)

SMTP notifications (optional)

Verbose debug logging and TLS controls for lab environments