# Regenerates assets/vet-run.png, the terminal capture in both READMEs:
#   bun run build && bun run pack && vhs assets/vet-run.tape
# It installs the packed tarballs into a project directory named my-app under ${TMPDIR:-/tmp}
# (removed and recreated on every run, so the capture shows a plain path and no random temp name),
# then runs the two quickstart commands with no judge key set. The image is static on purpose: no
# Output directive, so no gif or video is written. The look depends on the fonts of the machine
# that runs it. After capture the PNG is reduced to 32 colours to stay under 150 KB:
#   magick assets/vet-run.png -colors 32 PNG8:assets/vet-run.png
#   rm -rf "${TMPDIR:-/tmp}/my-app"
#
# assets/vet-report.png, the HTML report in both READMEs, is a headless Chrome screenshot of the
# report.html of a keyless run: the fixture project with four more cases and its in-process judge
# in alternate mode, so the report has passing and failing cases. From the repo root:
#   bun run build
#   S="$(mktemp -d)" && cp -r fixtures/cli/run/. "$S"
#   for i in 2 3 4 5; do printf '{"id":"case-%s","input":{"state":"User: hi\\nAssistant: Hello! How can I help?"},"provenance":null,"tags":[]}\n' "$i"; done >>"$S/evals/cases/cases.jsonl"
#   (cd "$S" && VETKIT_FIXTURE_MODE=alternate node "$OLDPWD/packages/cli/dist/bin.js" run --reporter html)
#   google-chrome-stable --headless=new --disable-gpu --hide-scrollbars --window-size=1100,700 --screenshot="$S/shot.png" "file://$S/.vet/report.html"
#   magick "$S/shot.png" -trim +repage -bordercolor white -border 24 +dither -colors 64 PNG8:assets/vet-report.png
#   rm -rf "$S"
Set Shell bash
Set FontFamily "DejaVu Sans Mono"
Set FontSize 13
Set Width 860
Set Height 500
Set Padding 12

Hide
Type `D=$PWD/dist-tarballs; A="${TMPDIR:-/tmp}/my-app"; rm -rf "$A" && mkdir -p "$A" && cd "$A" && node -e 'const fs=require("fs"),path=require("path"),cp=require("child_process");const d=process.argv[1],deps={};for(const f of fs.readdirSync(d).filter(f=>f.endsWith(".tgz"))){const t=path.join(d,f);deps[JSON.parse(cp.execFileSync("tar",["-xzOf",t,"package/package.json"],{encoding:"utf8"})).name]="file:"+t}fs.writeFileSync("package.json",JSON.stringify({name:"demo",private:true,type:"module",dependencies:deps,overrides:deps}))' "$D" && npm install --no-audit --no-fund >/dev/null 2>&1`
Enter
Sleep 30s
Type "exec env -u OPENROUTER_API_KEY -u AI_GATEWAY_API_KEY -u TYPESAFE_API_KEY -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID PS1='$ ' bash --norc --noprofile"
Enter
Sleep 2s
Type "clear"
Enter
Sleep 1s
Show

Type "npx vetkit init"
Enter
Sleep 8s
Type "npx vetkit run"
Enter
Sleep 12s
Screenshot assets/vet-run.png
Sleep 1s
