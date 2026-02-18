const net = require('net');
const nodes = require('./nodes.json');

const LISTEN_PORT = 3000;

const server = net.createServer((clientSocket) => {

  clientSocket.once('data', (data) => {
    // Extract hostname from SNI (Cloudflare passes it via HTTP CONNECT)
    const firstLine = data.toString();
    const match = firstLine.match(/Host: ([^\r\n]+)/i);

    if (!match) {
      clientSocket.destroy();
      return;
    }

    const domain = match[1]; // 3000e.vapp.uk
    console.log("Domain:", domain);

    const sub = domain.split('.')[0]; // 3000e

    const port = sub.match(/^\d+/)?.[0];      // 3000
    const cnode = sub.match(/[a-z]+$/)?.[0];  // e

    if (!port || !cnode) {
      clientSocket.destroy();
      return;
    }

    const node = nodes[cnode];
    if (!node) {
      clientSocket.destroy();
      return;
    }

    console.log(`Forwarding to ${node}:${port}`);

    const targetSocket = net.connect(port, node, () => {
      targetSocket.write(data);
      clientSocket.pipe(targetSocket);
      targetSocket.pipe(clientSocket);
    });

    targetSocket.on('error', () => {
      clientSocket.destroy();
    });
  });
});

server.listen(LISTEN_PORT, () => {
  console.log(`TCP Proxy listening on ${LISTEN_PORT}`);
});
