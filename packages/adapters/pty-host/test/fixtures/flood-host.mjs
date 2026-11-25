// Host de prueba que inunda de mensajes inválidos tras lanzar una terminal.
process.send({ t: 'ready' })
process.on('message', (msg) => {
  if (msg.t !== 'spawn') return
  process.send({ t: 'spawned', id: msg.id, pid: 4242 })
  for (let i = 0; i < 100; i++) process.send({ t: 'basura', i })
  setInterval(() => {}, 1000)
})
