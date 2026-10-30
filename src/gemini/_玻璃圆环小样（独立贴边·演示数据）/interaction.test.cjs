// 对纯手势和几何的公开接口验收，不调用私有方法或模拟内部协作者。
const {test}=require("node:test"),assert=require("node:assert/strict");
const {nextIndex,movement,HOLD_MS}=require("./interaction.js");
const {dockOrb,panelBounds}=require("./geometry.cjs");
test("左右切号按一二三循环，单号保持自己",()=>{
 assert.equal(nextIndex(1,"next",2),0);assert.equal(nextIndex(0,"previous",2),1);
 assert.equal(nextIndex(2,"next",3),0);assert.equal(nextIndex(0,"previous",3),2);
 assert.equal(nextIndex(0,"next",1),0);assert.equal(nextIndex(0,"previous",1),0);
});
test("未长按时左右划是切号，垂直或小抖动不触发",()=>{
 assert.equal(movement(-18,2,false),"next");assert.equal(movement(18,2,false),"previous");
 assert.equal(movement(4,2,false),"none");assert.equal(movement(5,18,false),"none");
});
test("按住半秒后的移动才用于拖动，长按不混成切号",()=>{
 assert.equal(HOLD_MS,500);assert.equal(movement(-18,2,true),"drag");
 assert.equal(movement(3,2,true),"none");assert.equal(movement(2,18,true),"drag");
});
test("右侧和左侧几何有固定已知落点",()=>{
 const a={x:0,y:0,width:1922,height:778};
 assert.deepEqual(dockOrb(a,"right",450),{x:1851,y:417,width:66,height:66});
 assert.deepEqual(dockOrb(a,"left",450),{x:5,y:417,width:66,height:66});
 assert.deepEqual(panelBounds(a,dockOrb(a,"right",450)),{x:1621,y:409,width:224,height:218});
});
test("工作区边缘和负坐标显示器不把球或详情推出屏幕",()=>{
 for(const a of [{x:0,y:0,width:1922,height:778},{x:-1920,y:-200,width:1920,height:1080}])
 for(const side of ["left","right"])for(const y of [-99999,99999]){
   for(const b of [dockOrb(a,side,y),panelBounds(a,dockOrb(a,side,y))]){
     assert(b.x>=a.x&&b.y>=a.y);assert(b.x+b.width<=a.x+a.width);assert(b.y+b.height<=a.y+a.height);
   }
 }
});
