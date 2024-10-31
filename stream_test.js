const http = require("http");

const options = {
  hostname: "localhost",
  port: 3030,
  path: "/realtime/v1/streams/test",
  method: "POST",
  headers: {
    "Content-Type": "application/x-ndjson",
    "Transfer-Encoding": "chunked", // Enable chunked transfer encoding
  },
};

const req = http.request(options, (res) => {
  console.log(`STATUS: ${res.statusCode}`);
  res.on("data", () => {});
  res.on("end", () => {
    console.log("No more data in response.");
  });
});

req.on("error", (e) => {
  console.error(`Problem with request: ${e.message}`);
});

// Function to send data with a delay
const sendData = (message, delay) => {
  setTimeout(() => {
    console.log(`Sending: ${message}`);
    req.write(message + "\n");
  }, delay);
};

sendData('{"message": "chunk 1"}', 0);
sendData('{"message": "chunk 2"}', 1000);
sendData('{"message": "chunk 3"}', 2000);
sendData('{"message": "chunk 4"}', 3000);

setTimeout(() => {
  req.end();
}, 4000);
