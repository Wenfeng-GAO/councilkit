# Host settings

Host settings is where a user checks that the local Runtime Host is the process serving this tab, including its instance id and Node version.

## Sub-features

- `settings-open` opens the settings page.
- `settings-host-online` shows section `1. Host` as online for this process.
- `settings-host-identity` shows the same `hostInstanceId` and Node version as `GET /api/v1/health`.

## How to get to it (user POV)

- Choose `检查 Host` on the home landing.
- Choose `设置` in the sidebar.
- Open `/settings` on the Runtime Host origin.

## Driving it with verify-councilkit

Preconditions:

- `launch.sh` has printed an origin and `doctor.sh` exited 0.
- `GET /api/v1/health` on that origin returns `apiVersion` `v1` and Node major 22.

- **Open settings.** Load `/settings`. Run `.cursor/skills/verify-councilkit/scripts/drive.sh host-settings`. The heading `设置` is visible.
- **Read the Host section.** The same command waits until the heading `1. Host` and the text `本地执行服务在线` are visible.
- **Match the running process.** The page text includes the `hostInstanceId` and `Node <version>` from `GET /api/v1/health`. `drive/host-settings/settings-host.png` and `settings.aria.txt` show that pair.
- **Proof.** `drive/host-settings/transcript.json` has `"ok": true`, the instance id, and the Node version.

## Gotchas

- `本地执行服务已断开，禁止新执行` means this tab is not talking to the Host `doctor.sh` checked. Stop and rerun doctor. Do not point the browser at `127.0.0.1:43127` unless this run owns that port, which it does not.
- `导出诊断包` downloads a JSON bundle that can contain local executable paths. The drive does not click it.
- The public health body is wrapped as `{ "ok": true, "data": { ... } }`. Compare `data.hostInstanceId`, not a top-level field.
