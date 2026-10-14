# New room

New room is where a user starts a browser discussion. With no Execution Profiles stored for this origin, the page stops on a gate and sends the user to Settings. The topic form appears only after at least two enabled Agents exist.

## Sub-features

- `new-room-open` shows the heading `新建讨论房间`.
- `new-room-empty-profiles` shows the gate `尚未配置 Execution Profile` and the button `前往 Runtime 设置`.
- `new-room-create` submits a topic with two Agents and a Facilitator. The fresh verification origin does not meet that precondition.

## How to get to it (user POV)

- Choose `去新建房间` or `从浏览器开讨论` on the home landing.
- Choose `新建讨论` in the sidebar.
- Open `/rooms/new` on the Runtime Host origin.

## Driving it with verify-councilkit

Preconditions:

- `launch.sh` has printed an origin and `doctor.sh` exited 0.
- This origin's IndexedDB has no Execution Profiles and no Agents. The launch script does not seed any.

- **Open the gate.** Load `/rooms/new`. Run `.cursor/skills/verify-councilkit/scripts/drive.sh new-room`. The heading `新建讨论房间`, the text `尚未配置 Execution Profile`, and the button `前往 Runtime 设置` are visible. `drive/new-room/01-empty-profiles.png` and `new-room.aria.txt` show that gate.
- **Create a room.** The same command looks for the textbox named `话题`. On a fresh origin the textbox is absent, `transcript.json` records sub-feature `new-room-create` as an unmet precondition, and the script exits 2.
- **Proof of the gate.** The screenshot and transcript exist even when the exit code is 2. The exit code means the create path was not verified.

## Gotchas

- Do not insert Agents through IndexedDB or `/api/v1/__test__` to force the form open. That skips the user path.
- `还没有可用的 Agent` and `还需要再创建一个 Agent` are later gates. Reaching them requires Profiles the baseline does not have, so they stay unverified on a fresh origin.
- The button `前往 Runtime 设置` navigates to `/settings`. The host-settings feature covers that page. This drive does not click through and call it a created room.
- Submitting the full form needs a trusted Runtime Installation and a real model call. This skill does not do that.
