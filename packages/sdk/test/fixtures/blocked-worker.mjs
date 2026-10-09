export default function start(_ipc, ready) {
  ready()
  setTimeout(() => {
    let spins = 0
    while (spins >= 0) spins++
  }, 200)
}
