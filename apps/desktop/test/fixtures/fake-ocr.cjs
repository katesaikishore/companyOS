// A stand-in for companyos-ocr that speaks its protocol: four big-endian length bytes, then the frame, and one JSON line
// back. The frame's own bytes say what to do, so tests can ask for text, a failure, an exit or no answer at all.
let buffered = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32BE(0)) {
    const frame = buffered.subarray(4, 4 + buffered.readUInt32BE(0)).toString();
    buffered = buffered.subarray(4 + buffered.readUInt32BE(0));
    if (frame === 'exit') process.exit(3);
    if (frame === 'hang') continue;
    if (frame === 'fail') process.stdout.write('{"error":"recognise"}\n');
    else if (frame === 'garbled') process.stdout.write('not json\n');
    else process.stdout.write(`${JSON.stringify({ text: `read ${frame}` })}\n`);
  }
});
