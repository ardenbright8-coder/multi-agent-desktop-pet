// Agent命令快捷窗口的界面：主进程每次弹出时发来按钮名单和身后那块屏幕的截图，画一遍（顺带重播浮上来的动画）。
// 点一下＝报序号给主进程；按住拖＝插入（2026-10-17 从「交换」改的）：别的按钮实时滑开让位，拖到最上面、最下面、缝里都能落，
// 松手先滑进空位再定下来，功能跟着按钮走。
// 拖和点用同一套按下/松开判断：按下后挪了 4 像素以上算拖，没挪算点。
// 🚨 拖之前要先关掉浮上来的动画（no-anim）：动画停在最后一帧会一直压着 transform，按钮跟不上鼠标（10-12 版拖不动的根）。
(function () {
  var list = document.getElementById("qc-list");
  var bg = document.getElementById("qc-bg");
  var labels = [];
  var drag = null;
  var SETTLE_MS = 160;

  window.quickcmd.onButtons(function (payload) {
    bg.style.backgroundImage = payload.background ? "url(" + payload.background + ")" : "none";
    labels = payload.labels.slice();
    draw(true);
  });

  function draw(animate) {
    list.textContent = "";
    list.classList.toggle("no-anim", !animate);
    list.classList.remove("sorting");
    labels.forEach(function (label, index) {
      var button = document.createElement("button");
      button.className = "glass";
      button.style.animationDelay = (0.04 + index * 0.04) + "s";
      var text = document.createElement("span");
      text.className = "txt";
      text.textContent = label;
      button.appendChild(text);
      button.addEventListener("pointerdown", function (event) { startDrag(event, button, index); });
      list.appendChild(button);
    });
  }

  // 挪和松手挂在整个窗口上，不挂在按钮上：按钮丢了指针捕获（拖出窗口时会），松手照样收得到，不会卡在半空。
  window.addEventListener("pointermove", function (event) { moveDrag(event); });
  window.addEventListener("pointerup", function () { endDrag(false); });
  window.addEventListener("pointercancel", function () { endDrag(true); });

  function startDrag(event, button, index) {
    if (event.button !== 0 || (drag && drag.settling)) return;
    button.setPointerCapture(event.pointerId);
    drag = { button: button, index: index, startY: event.clientY, moved: false, to: index, slot: 0, settling: false };
  }

  function moveDrag(event) {
    if (!drag || drag.settling) return;
    var dy = event.clientY - drag.startY;
    if (!drag.moved && Math.abs(dy) < 4) return;
    if (!drag.moved) begin();
    var count = list.children.length;
    // 只在这一列里上下走：最多到第一个、最后一个的位置，鼠标拖出窗口也跟着贴边。
    var min = -drag.index * drag.slot;
    var max = (count - 1 - drag.index) * drag.slot;
    var offset = Math.max(min, Math.min(max, dy));
    drag.button.style.transform = "translateY(" + offset + "px) scale(1.04)";
    var to = drag.index + Math.round(offset / drag.slot);
    if (to !== drag.to) {
      drag.to = to;
      makeRoom();
    }
  }

  /** 真开始拖：关掉浮上来的动画、量一格多高（按钮高 + 间距）、拿起来。 */
  function begin() {
    drag.moved = true;
    list.classList.add("no-anim", "sorting");
    var first = list.children[0].getBoundingClientRect();
    var second = list.children[1] ? list.children[1].getBoundingClientRect() : null;
    drag.slot = second ? second.top - first.top : first.height;
    drag.button.classList.add("dragging");
  }

  /** 拿起的按钮要落到第 to 个：夹在中间的那几个各让一格，其余回原位。 */
  function makeRoom() {
    for (var i = 0; i < list.children.length; i += 1) {
      if (i === drag.index) continue;
      var shift = 0;
      if (drag.index < i && i <= drag.to) shift = -drag.slot;
      else if (drag.to <= i && i < drag.index) shift = drag.slot;
      list.children[i].style.transform = shift ? "translateY(" + shift + "px)" : "";
    }
  }

  /** 松手：没挪过算点（被系统打断的不算点）；挪过就落到当前让出来的空位。 */
  function endDrag(cancelled) {
    if (!drag || drag.settling) return;
    var done = drag;
    if (!done.moved) {
      drag = null;
      if (!cancelled) window.quickcmd.press(done.index);
      return;
    }
    // 先滑进空位，滑完再按新顺序重画（重画不重播浮上来的动画）。
    done.settling = true;
    done.button.classList.add("settling");
    done.button.style.transform = "translateY(" + (done.to - done.index) * done.slot + "px)";
    setTimeout(function () {
      drag = null;
      if (done.to !== done.index) {
        var moving = labels.splice(done.index, 1)[0];
        labels.splice(done.to, 0, moving);
        window.quickcmd.move(done.index, done.to);
      }
      draw(false);
    }, SETTLE_MS);
  }
})();
