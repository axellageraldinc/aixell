// One shared 500 ms timer for every running counter. Callbacks that return false are dropped.
const subscribers = new Set();
let timer = 0;

export function onTick(callback) {
  subscribers.add(callback);
  callback();
  if (!timer) {
    timer = setInterval(() => {
      for (const fn of [...subscribers]) if (fn() === false) subscribers.delete(fn);
      if (subscribers.size === 0) { clearInterval(timer); timer = 0; }
    }, 500);
  }
  return () => subscribers.delete(callback);
}
