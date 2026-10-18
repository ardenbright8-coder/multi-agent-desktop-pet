// 板块与内存窗口的界面：每 2 秒问主进程要一次数，重画。只认 window.overview。函数名带 ov 前缀，防跟别的界面全局撞名。

const LEVEL_CLASS = { 绿: "lv-green", 黄: "lv-yellow", 红: "lv-red" };
const LEVEL_TEXT = { 绿: "绿：宽裕", 黄: "黄：到警戒线了，新功能考虑另开一个自启程序", 红: "红：太大了，该拆出去了" };

function ovEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function ovDrawBlocks(blocks) {
  const running = blocks.filter((block) => block.state === "在跑").length;
  document.querySelector("#block-count").textContent = `一共 ${blocks.length} 个板块，${running} 个在跑`;
  const list = document.querySelector("#blocks");
  list.replaceChildren(...blocks.map((block) => {
    const item = ovEl("li");
    item.append(ovEl("span", "name", block.name));
    item.append(ovEl("span", `state${block.state === "在跑" ? "" : block.state === "出错" ? " bad" : " off"}`, block.state));
    item.append(ovEl("span", "what", block.detail ? `${block.what}｜${block.detail}` : block.what));
    return item;
  }));
}

function ovDrawMemory(memory) {
  const top = memory.redMB * 1.25;
  const fill = document.querySelector("#meter-fill");
  fill.style.width = `${Math.min(100, (memory.totalMB / top) * 100)}%`;
  fill.className = `meter-fill ${LEVEL_CLASS[memory.level]}`;
  document.querySelector("#mark-yellow").style.left = `${(memory.yellowMB / top) * 100}%`;
  document.querySelector("#mark-red").style.left = `${(memory.redMB / top) * 100}%`;
  document.querySelector("#total").textContent = `${memory.totalMB} MB`;
  const level = document.querySelector("#level");
  level.textContent = LEVEL_TEXT[memory.level];
  level.className = `level ${LEVEL_CLASS[memory.level]}`;
  document.querySelector("#room").textContent = memory.roomMB > 0
    ? `警戒线：${memory.yellowMB} MB 黄、${memory.redMB} MB 红。离黄线还有 ${memory.roomMB} MB，大约还能加 ${memory.roomBackground} 个后台板块，或 ${memory.roomWindow} 个带窗口的板块。`
    : `警戒线：${memory.yellowMB} MB 黄、${memory.redMB} MB 红。已经过黄线了。`;
  document.querySelector("#procs").replaceChildren(...memory.rows.map((row) => {
    const item = ovEl("li");
    item.append(ovEl("span", "name", row.label));
    item.append(ovEl("span", "mb", `${row.mb} MB`));
    item.append(ovEl("span", "what", row.what));
    return item;
  }));
}

async function ovRefresh() {
  try {
    const data = await window.overview.get();
    ovDrawBlocks(data.blocks || []);
    ovDrawMemory(data.memory);
  } catch (error) {
    document.querySelector("#block-count").textContent = `读取出错：${error && error.message ? error.message : error}`;
  }
}

ovRefresh();
setInterval(ovRefresh, 2000);
