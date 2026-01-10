migrations/
├─ 0001_init_users.sql
├─ 001_initial.sql
├─ 003_p2p_marketplace.sql

scripts/
├─ deploy-workers.sh
├─ setup-config.sh
├─ create_sample_tld.py
├─ generate_keys.py

server/
├─ app.js
├─ server.js
├─ server-dev.js
├─ local-server.js
├─ run-test.js
├─ routes/
│   ├─ api.js
│   ├─ auth.js
│   ├─ email.js
│   ├─ marketplace.js
│   └─ tl3-converter.js
├─ workers/
│   ├─ api.js
│   ├─ auth.js
│   ├─ wallet.js
│   ├─ ledger.js
│   ├─ constants.js
│   ├─ files.js
│   ├─ worker.js
│   └─ email-service.js
└─ lib/
    ├─ crypto.js
    ├─ send-email.js
    └─ helpers.js

timelink-mvp/
├─ converter/
│   ├─ __init__.py
│   ├─ main.py
│   ├─ run_converter.py
├─ viewer/
│   ├─ __init__.py
│   ├─ gui_viewer.py
│   ├─ main.py
│   └─ run_viewer.py
├─ keys/
│   ├─ private_test.key
│   └─ public_test.pub
├─ scripts/
├─ setup.py
└─ requirements.txt

workers/
├─ src/
│   ├─ index.js
│   ├─ package.json
│   ├─ package-lock.json
│   └─ wrangler.toml
├─ test-worker.js
└─ README.md

.gitignore
README.md
SECURITY.md
