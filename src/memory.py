"""Facts of Hermes' long-term memory (holographic plugin), through the plugin's own MemoryStore so history, links and
search indexes stay consistent. argv: <profile home> <db path>; stdin: {"action": "list" | "update" | "remove", ...}."""
import json
import os
import sys

home, db_path = sys.argv[1], sys.argv[2]
os.environ['HERMES_HOME'] = home
sys.path.insert(0, os.environ['HERMES_AGENT_DIR'])
sys.path.insert(0, os.environ['HERMES_PLUGINS_DIR'])
sys._hermes_pin_default_home = True
import hermes_bootstrap  # noqa: E402,F401
from holographic.store import DuplicateContentError, MemoryStore  # noqa: E402

request = json.loads(sys.stdin.read() or '{}')
store = MemoryStore(db_path)
action = request.get('action')
try:
    if action == 'list':
        facts = store.list_facts(limit=5000)
        print(json.dumps({'facts': [{k: f.get(k) for k in ('fact_id', 'content', 'category', 'tags', 'trust_score', 'retrieval_count', 'created_at', 'updated_at')} for f in facts]}))
    elif action == 'update':
        print(json.dumps({'ok': bool(store.update_fact(int(request['id']), content=str(request['content'])))}))
    elif action == 'remove':
        print(json.dumps({'ok': bool(store.remove_fact(int(request['id'])))}))
    else:
        print(json.dumps({'error': 'bad_action'}))
except DuplicateContentError:
    print(json.dumps({'error': 'duplicate'}))
except ValueError as exc:
    print(json.dumps({'error': 'invalid', 'detail': str(exc)[:200]}))
