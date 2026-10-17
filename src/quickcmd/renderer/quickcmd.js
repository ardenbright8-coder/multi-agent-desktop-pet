// Agent命令快捷窗口的界面：主进程每次弹出时发来按钮名单和身后那块屏幕的截图，画一遍（顺带重播浮上来的动画）。
// 点一下＝报序号给主进程去按键；按住拖到别的按钮上松手＝两个交换位置（2026-10-12 用户要的），功能跟着按钮走。
// 拖和点用同一套按下/松开判断：按下后挪了 4 像素以上算拖，没挪算点。
(function () {
  var list = document.getElementById("qc-list");
  var bg = document.getElementById("qc-bg");
  var labels = [];
  var drag = null;

  window.quickcmd.onButtons(function (payload) {
    bg.style.backgroundImage = payload.background ? "url(" + payload.background + ")" : "none";
    labels = payload.labels.slice();
    draw(true);
  });

  function draw(animate) {
    list.textContent = "";
    list.classList.toggle("no-anim", !animate);
    labels.forEach(function (label, index) {
      var button = document.createElement("button");
      button.className = "glass";
      button.style.animationDelay = (0.04 + index * 0.04) + "s";
      var text = document.createElement("span");
      text.className = "txt";
      text.textContent = label;
      button.appendChild(text);
      button.addEventListener("pointerdown", function (event) { startDrag(event, button, index); });
      button.addEventListener("pointermove", function (event) { moveDrag(event); });
      button.addEventListener("pointerup", function (event) { endDrag(event); });
      button.addEventListener("pointercancel", function () { cancelDrag(); });
      list.appendChild(button);
    });
  }

  function startDrag(event, button, index) {
    if (event.button !== 0) return;
    button.setPointerCapture(event.pointerId);
    drag = { button: button, index: index, startY: event.clientY, moved: false, over: -1 };
  }

  function moveDrag(event) {
    if (!drag) return;
    var dy = event.clientY - drag.startY;
    if (!drag.moved && Math.abs(dy) < 4) return;
    if (!drag.moved) {
      drag.moved = true;
      drag.button.classList.add("dragging");
    }
    drag.button.style.transform = "translateY(" + dy + "px) scale(1.04)";
    var over = indexAt(event.clientY, drag.index);
    if (over !== drag.over) {
      if (drag.over >= 0) list.children[drag.over].classList.remove("swap-target");
      if (over >= 0) list.children[over].classList.add("swap-target");
      drag.over = over;
    }
  }

  function endDrag(event) {
    if (!drag) return;
    var done = drag;
    drag = null;
    if (!done.moved) {
      window.quickcmd.press(done.index);
      return;
    }
    var to = indexAt(event.clientY, done.index);
    if (to >= 0) {
      var moving = labels[done.index];
      labels[done.index] = labels[to];
      labels[to] = moving;
      window.quickcmd.swap(done.index, to);
    }
    draw(false);
  }

  function cancelDrag() {
    if (!drag) return;
    drag = null;
    draw(false);
  }

  /** 鼠标这个高度落在哪个按钮上（不算正在拖的那个），都不在给 -1。 */
  function indexAt(y, skip) {
    for (var i = 0; i < list.children.length; i += 1) {
      if (i === skip) continue;
      var box = list.children[i].getBoundingClientRect();
      if (y >= box.top && y <= box.bottom) return i;
    }
    return -1;
  }
})();
