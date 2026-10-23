"""Rewinds the last user turn of one Hermes session (what /undo and /retry do) and prints the removed text as JSON.
Run through src/rewind.js with the Hermes interpreter; argv: <profile home> <session id>. It uses Hermes' own
SessionDB.rewind_user_turn, so history, compaction carriers and search indexes stay consistent."""
import json
import os
import sys

home, session_id = sys.argv[1], sys.argv[2]
os.environ['HERMES_HOME'] = home
sys.path.insert(0, os.environ['HERMES_AGENT_DIR'])
sys._hermes_pin_default_home = True
import hermes_bootstrap  # noqa: E402,F401  (puts Hermes' own dependencies on the path)
from pathlib import Path  # noqa: E402
from hermes_state import SessionDB  # noqa: E402
from hermes_state_rewind import RewindTargetUnavailableError  # noqa: E402

db = SessionDB(Path(home) / 'state.db')
try:
    outcome = db.rewind_user_turn(session_id, -1, require_retryable=True)
except RewindTargetUnavailableError:
    print(json.dumps({'error': 'nothing_to_rewind'}))
except ValueError as exc:  # the message is not plain text (attachments, images): not replayable as text
    print(json.dumps({'error': 'not_text', 'detail': str(exc)[:200]}))
else:
    print(json.dumps({'ok': True, 'text': outcome.live_text, 'rewound': outcome.rewound_count, 'turns': outcome.turns_undone}))
