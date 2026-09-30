# Regenerates assets/vet-run.png, the terminal capture in both READMEs:
#   bun run build && bun run pack && vhs assets/vet-run.tape
# It installs the packed tarballs into a temp project, then runs the two quickstart commands with
# no judge key set. The image is static on purpose: no Output directive, so no gif or video is
# written. The look depends on the fonts of the machine that runs it. After capture the PNG is
# reduced to 32 colours to stay under 150 KB: convert assets/vet-run.png -colors 32 PNG8:assets/vet-run.png
Set Shell bash
Set FontFamily "DejaVu Sans Mono"
Set FontSize 13
Set Width 860
Set Height 500
Set Padding 12

Hide
Type `D=$PWD/dist-tarballs; cd $(mktemp -d) && node -e 'const fs=require("fs"),path=require("path"),cp=require("child_process");const d=process.argv[1],deps={};for(const f of fs.readdirSync(d).filter(f=>f.endsWith(".tgz"))){const t=path.join(d,f);deps[JSON.parse(cp.execFileSync("tar",["-xzOf",t,"package/package.json"],{encoding:"utf8"})).name]="file:"+t}fs.writeFileSync("package.json",JSON.stringify({name:"demo",private:true,type:"module",dependencies:deps,overrides:deps}))' "$D" && npm install --no-audit --no-fund >/dev/null 2>&1`
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
