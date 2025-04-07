module.exports = (io) => {
    io.on('connection', (socket) => {
      socket.on('game1-action', (data) => {
        console.log('Game 1 action:', data);
        io.emit('game1-update', data);
      });
    });
  };