#!/usr/bin/env bash
# Concatenates the page shell (src/head.html, which opens the <script> tag) with the physics core and the UI code
# into one self-contained dist/index.html, then syntax-checks the resulting script.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
{ cat src/head.html src/core.js src/app.js; printf '\n</script>\n</body>\n</html>\n'; } > dist/index.html
python3 - <<'PY'
s = open('dist/index.html').read()
i = s.index('<script>') + 8
j = s.rindex('</script>')
open('dist/.script-check.js', 'w').write(s[i:j])
PY
node --check dist/.script-check.js
rm dist/.script-check.js
touch dist/.nojekyll
echo "built dist/index.html"
