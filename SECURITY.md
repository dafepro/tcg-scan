# Security

Do not post credentials, personal card photographs, collection backups, or exploit details containing personal data in a public issue. For a security-sensitive issue, use the repository owner’s GitHub profile to find an appropriate private contact before disclosing details. A dedicated private reporting channel is not configured by this project.

Current security model: static browser application; no accounts, backend, API credentials or remote collection storage. Public catalog responses and imported backups are treated as untrusted. Photos/recordings stay local. Imported links are restricted to known provider hosts, and CSV spreadsheet-formula prefixes are neutralized.

Keep dependencies current and run `npm audit` as well as tests when updating. Unit tests and defensive validation reduce risk; they are not a formal security audit.
