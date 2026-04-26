#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FREE_CODE_ROOT="${FREE_CODE_ROOT:-}"
if [[ -z "${FREE_CODE_ROOT}" ]]; then
  for candidate in \
    "/Users/karlchow/Desktop/code/free-code" \
    "$HOME/free-code" \
    "$HOME/code/free-code"; do
    if [[ -d "${candidate}" ]]; then
      FREE_CODE_ROOT="${candidate}"
      break
    fi
  done
fi
CORE_TYPES="${FREE_CODE_ROOT}/src/entrypoints/sdk/coreTypes.ts"
HOOKS_JSON="${REPO_ROOT}/plugins/claude-star-office-bridge/hooks/hooks.json"
STATE_MAPPER="${REPO_ROOT}/src/stateMapper.ts"

for path in "${HOOKS_JSON}" "${STATE_MAPPER}"; do
  if [[ ! -f "${path}" ]]; then
    echo "[hook-coverage] required file missing: ${path}" >&2
    exit 1
  fi
done

if [[ -z "${FREE_CODE_ROOT}" ]] || [[ ! -f "${CORE_TYPES}" ]]; then
  echo "[hook-coverage] free-code not found; using hardcoded 27 canonical event list"
  python3 - "${HOOKS_JSON}" "${STATE_MAPPER}" <<'PY_FALLBACK'
import json
import re
import sys

hooks_json_path = sys.argv[1]
state_mapper_path = sys.argv[2]

canonical = [
    "PreToolUse", "PostToolUse", "PostToolUseFailure",
    "Notification", "UserPromptSubmit", "SessionStart", "SessionEnd",
    "Stop", "StopFailure", "SubagentStart", "SubagentStop",
    "PreCompact", "PostCompact", "PermissionRequest", "PermissionDenied",
    "Setup", "TeammateIdle", "TaskCreated", "TaskCompleted",
    "Elicitation", "ElicitationResult", "ConfigChange",
    "InstructionsLoaded", "CwdChanged", "FileChanged",
    "WorktreeCreate", "WorktreeRemove",
]

with open(hooks_json_path, "r", encoding="utf-8") as fh:
    hooks_data = json.load(fh)

hook_names = set()
for event_name, entries in hooks_data.get("hooks", {}).items():
    hook_names.add(event_name)

missing_from_plugin = [name for name in canonical if name not in hook_names]
extra_in_plugin = [name for name in hook_names if name not in canonical]

if missing_from_plugin:
    print(f"[hook-coverage] plugin missing events: {', '.join(missing_from_plugin)}", file=sys.stderr)
    sys.exit(1)
if extra_in_plugin:
    print(f"[hook-coverage] plugin has extra events: {', '.join(extra_in_plugin)}", file=sys.stderr)
    sys.exit(1)

print(f"[hook-coverage] ok: {len(canonical)} free-code events (hardcoded list)")
print(f"[hook-coverage] plugin subscriptions: {len(hook_names)}")

with open(state_mapper_path, "r", encoding="utf-8") as fh:
    mapper_text = fh.read()

mapper_cases = set(re.findall(r'case\s+"(\w+)"', mapper_text))
mapper_hook_cases = [name for name in mapper_cases if name in canonical]
missing_from_mapper = [name for name in canonical if name not in mapper_cases]

if missing_from_mapper:
    print(f"[hook-coverage] mapper missing events: {', '.join(missing_from_mapper)}", file=sys.stderr)
    sys.exit(1)

print(f"[hook-coverage] mapEventToState mappings: {len(mapper_hook_cases)}")
PY_FALLBACK
  exit $?
fi

python3 - "${CORE_TYPES}" "${HOOKS_JSON}" "${STATE_MAPPER}" <<'PY'
import json
import re
import sys
from pathlib import Path

core_types_path = Path(sys.argv[1])
hooks_json_path = Path(sys.argv[2])
state_mapper_path = Path(sys.argv[3])

core_types = core_types_path.read_text()
hooks_json = json.loads(hooks_json_path.read_text())
state_mapper = state_mapper_path.read_text()

hook_events_match = re.search(
    r"export\s+const\s+HOOK_EVENTS\s*=\s*\[(.*?)\]\s+as\s+const",
    core_types,
    re.S,
)
if not hook_events_match:
    print(f"[hook-coverage] could not find HOOK_EVENTS in {core_types_path}", file=sys.stderr)
    sys.exit(1)

hook_events = re.findall(r"['\"]([^'\"]+)['\"]", hook_events_match.group(1))
if not hook_events:
    print("[hook-coverage] HOOK_EVENTS is empty", file=sys.stderr)
    sys.exit(1)

plugin_hooks = hooks_json.get("hooks")
if not isinstance(plugin_hooks, dict):
    print(f"[hook-coverage] {hooks_json_path} has no top-level hooks object", file=sys.stderr)
    sys.exit(1)

subscribed_events = sorted(plugin_hooks.keys())

function_start = state_mapper.find("function mapEventToState(")
if function_start == -1:
    print(f"[hook-coverage] could not find mapEventToState in {state_mapper_path}", file=sys.stderr)
    sys.exit(1)

brace_start = state_mapper.find("{", function_start)
if brace_start == -1:
    print("[hook-coverage] could not find mapEventToState body", file=sys.stderr)
    sys.exit(1)

depth = 0
body_end = None
for index in range(brace_start, len(state_mapper)):
    char = state_mapper[index]
    if char == "{":
        depth += 1
    elif char == "}":
        depth -= 1
        if depth == 0:
            body_end = index
            break

if body_end is None:
    print("[hook-coverage] could not parse mapEventToState body", file=sys.stderr)
    sys.exit(1)

map_event_body = state_mapper[brace_start:body_end]
mapped_events = sorted(set(re.findall(r"case\s+['\"]([^'\"]+)['\"]\s*:", map_event_body)))

hook_event_set = set(hook_events)
subscribed_event_set = set(subscribed_events)
mapped_event_set = set(mapped_events)

missing_subscriptions = sorted(hook_event_set - subscribed_event_set)
stale_subscriptions = sorted(subscribed_event_set - hook_event_set)
missing_mappings = sorted(hook_event_set - mapped_event_set)
stale_mappings = sorted(mapped_event_set - hook_event_set)

failures = []
if missing_subscriptions:
    failures.append(("missing plugin subscriptions", missing_subscriptions))
if stale_subscriptions:
    failures.append(("plugin subscriptions not defined by free-code", stale_subscriptions))
if missing_mappings:
    failures.append(("missing mapEventToState mappings", missing_mappings))
if stale_mappings:
    failures.append(("mapEventToState mappings not defined by free-code", stale_mappings))

if failures:
    for title, events in failures:
        print(f"[hook-coverage] {title}:", file=sys.stderr)
        for event in events:
            print(f"  - {event}", file=sys.stderr)
    sys.exit(1)

print(f"[hook-coverage] ok: {len(hook_events)} free-code events")
print(f"[hook-coverage] plugin subscriptions: {len(subscribed_events)}")
print(f"[hook-coverage] mapEventToState mappings: {len(mapped_events)}")
PY
