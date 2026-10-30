// 只检查当前用量组件；不扫描、不改造其他板块。
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const files = ["main.cjs","native-glass.cjs","geometry.cjs","interaction.js","preload.cjs","ui.js"];
const external = new Set(["electron","koffi","node:path","node:fs","node:os"]);
let imports = 0;
for (const name of files) {
  const text = fs.readFileSync(path.join(__dirname,name),"utf8");
  for (const match of text.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const target=match[1];imports++;
    if(target.startsWith(".")){
      assert(!target.startsWith("../"),name+" 不许依赖本块外部实现");
      assert(files.includes(target.slice(2)),name+" 引用了未知内部模块 "+target);
    }else assert(external.has(target),name+" 引入了未批准依赖 "+target);
  }
  for(const forbidden of ["SetCursorPos","SendInput","mouse_event","SetForegroundWindow","globalShortcut","desktopCapturer","RegSetValue","nodeIntegration: true","webSecurity: false","ELECTRON_DISABLE_SECURITY_WARNINGS"])
    assert(!text.includes(forbidden),name+" 出现禁止项 "+forbidden);
}
const html=fs.readFileSync(path.join(__dirname,"index.html"),"utf8");
assert(html.indexOf('src="interaction.js"')<html.indexOf('src="ui.js"'),"纯手势判断必须先于界面绑定加载");
assert(!fs.readFileSync(path.join(__dirname,"style.css"),"utf8").includes("radial-gradient"),"不能恢复塑料径向高光");
console.log("QUOTA_BOUNDARIES_OK modules="+files.length+" imports="+imports);
