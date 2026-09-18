// The image-marker handling on its own, with a map standing in for the
// runtime's filesystem.
//
//   node test/live-output.mjs

import { LiveOutput, overprint, isCompletePng } from '../web/wwwroot/live-output.js';

let failures = 0;

function check(what, ok, detail = '') {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `  ${detail}` : ''}`);
}

function png(fill, size = 32) {
    const bytes = new Uint8Array(size);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    bytes.fill(fill, 8, size - 12);
    bytes.set([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82], size - 12);
    return bytes;
}

const files = new Map();
const readFile = path => files.get(path) ?? null;

{
    const live = new LiveOutput({ readFile });

    files.set('frame.png', png(1));
    live.feed('before\n<<image frame.png>>\n');
    check('a marker becomes a picture', live.images.length === 1 && live.takeChanged());
    check('the marker line is taken out', live.text === 'before\n', JSON.stringify(live.text));

    const first = live.images[0].url;

    files.set('frame.png', png(2));
    live.feed('<<image fra');
    check('half a marker line decides nothing', !live.takeChanged());
    live.feed('me.png>>\n');
    check('the same name again replaces the picture', live.images.length === 1 && live.images[0].url !== first);
    check('and reports a change', live.takeChanged());

    live.feed('<<image frame.png>>\n');
    check('an unchanged picture is not a change', !live.takeChanged());

    live.feed('<<image missing.png>>\n');
    check('a marker naming no file stays in the text', live.text.endsWith('<<image missing.png>>\n'));
}

{
    const live = new LiveOutput({ readFile });

    const whole = png(3);
    files.set('slow.png', whole.slice(0, 20));
    live.feed('<<image slow.png>>\n');
    check('a picture being written is not shown yet', live.images.length === 0);
    files.set('slow.png', whole);
    live.feed();
    check('and is shown on the next look', live.images.length === 1);
}

{
    const live = new LiveOutput({ readFile, maxImageBytes: 100 });

    files.set('a.png', png(4, 60));
    files.set('b.png', png(5, 60));
    live.feed('<<image a.png>>\n');
    live.feed('<<image a.png>>\n');
    files.set('a.png', png(6, 60));
    live.feed('<<image a.png>>\n');
    check('replacing a picture gives its bytes back', live.images.length === 1 && !live.text.includes('not shown'));
    live.feed('<<image b.png>>\n');
    check('a picture past the budget is not shown', live.images.length === 1 && live.text.includes('1 image(s) not shown'));
}

{
    const live = new LiveOutput({ readFile });

    files.set('end.png', png(7));
    live.feed('text\n<<image end.png>>');
    check('an unterminated last marker waits', live.images.length === 0);
    live.finish();
    check('until the output ends', live.images.length === 1 && live.text === 'text\n', JSON.stringify(live.text));
}

check('carriage return overprints', overprint('abc\rX') === 'Xbc');
check('a spinner shows its last frame', overprint('|\r/\r-\r\\\r') === '\\');
check('a CRLF line is unchanged', overprint('line\r') === 'line');
check('a truncated PNG is not complete', !isCompletePng(png(1).slice(0, 30)));

if (failures) {
    console.log(`${failures} failed`);
    process.exit(1);
}
