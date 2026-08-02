# Databricks notebook source
# Keepalive watcher for the home Databricks App.
#
# Runs hourly. If the app's compute is not up, it requests a start. This is a
# stopgap for Free Edition's 24-hour app auto-stop. It CANNOT work around a
# fair-usage quota stop ("compute stopped due to workspace or account status")
# — when the account is over quota, both this job and apps.start() are blocked.

from databricks.sdk import WorkspaceClient

APP_NAME = "home"

w = WorkspaceClient()
app = w.apps.get(name=APP_NAME)

compute = app.compute_status
state = compute.state.value if compute and compute.state else "UNKNOWN"
message = compute.message if compute else None
print(f"App '{APP_NAME}' compute state: {state}")
if message:
    print(f"Compute message: {message}")

# Already up or transitioning up — leave it alone.
if state in ("ACTIVE", "STARTING", "UPDATING"):
    print("App is active or already starting; nothing to do.")
else:
    print(f"App is {state}; requesting start...")
    try:
        w.apps.start(name=APP_NAME)
        print("Start requested. It can take a couple of minutes to become ACTIVE.")
    except Exception as err:  # noqa: BLE001 — surface the real reason in run output
        print(
            "Start failed. If the cause is account/quota status, this job cannot "
            "fix it — resolve the account standing in the Databricks account console."
        )
        raise err
