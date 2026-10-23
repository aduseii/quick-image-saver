'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const QIS = require('../src/resolve.js');

const ID = '3o7aCTPPm4OHfRLSH6';

test('giphy preview points at the original upload first', () => {
  const urls = QIS.gifOriginals(`https://media.giphy.com/media/${ID}/200w.gif`);
  assert.deepEqual(urls, [
    `https://media.giphy.com/media/${ID}/source.gif`,
    `https://media.giphy.com/media/${ID}/giphy.gif`
  ]);
  assert.equal(QIS.upgrades(`https://media0.giphy.com/media/${ID}/200_s.gif`)[0], urls[0]);
  assert.equal(QIS.upgrades(`https://media2.giphy.com/media/v1.Y2lkPabc/${ID}/giphy.webp`)[0], urls[0]);
  assert.equal(QIS.gifOriginals(`https://i.giphy.com/${ID}.mp4`)[0], urls[0]);
  assert.deepEqual(QIS.gifOriginals(`https://media.giphy.com/media/${ID}/source.gif`), []);
  assert.deepEqual(QIS.gifOriginals(`https://media.giphy.com/media/${ID}/giphy.gif`), [urls[0]]);
});

test('tenor size code is rewritten to the full GIF', () => {
  const tiny = 'https://media1.tenor.com/m/DEBMsntBV9gAAAAM/cat-smile.gif';
  const full = QIS.gifOriginals(tiny);
  assert.equal(full[0], 'https://c.tenor.com/DEBMsntBV9gAAAAC/tenor.gif');
  assert.equal(full[1], 'https://media.tenor.com/DEBMsntBV9gAAAAC/tenor.gif');
  assert.equal(QIS.isGifUrl(full[0]), true);

  const sticker = QIS.gifOriginals('https://c.tenor.com/abcDEF123AAAAj/sticker.gif');
  assert.equal(sticker[0], 'https://c.tenor.com/abcDEF123AAAAi/tenor.gif');
  assert.equal(sticker[1], 'https://media.tenor.com/abcDEF123AAAAi/tenor.gif');

  const legacy = QIS.gifOriginals('https://media.tenor.com/images/12345/tiny.gif');
  assert.deepEqual(legacy, ['https://media.tenor.com/images/12345/tenor.gif']);
  assert.deepEqual(QIS.gifOriginals('https://c.tenor.com/DEBMsntBV9gAAAAC/tenor.gif'), []);
  assert.deepEqual(QIS.gifOriginals(full[0]), []);
});

test('imgur gifv and sized gif resolve to the gif file', () => {
  assert.deepEqual(
    QIS.gifOriginals('https://i.imgur.com/abcdefg.gifv'),
    ['https://i.imgur.com/abcdefg.gif']
  );
  assert.deepEqual(
    QIS.gifOriginals('https://i.imgur.com/abcdefg.mp4'),
    ['https://i.imgur.com/abcdefg.gif']
  );
  assert.deepEqual(
    QIS.gifOriginals('https://i.imgur.com/abcdeh.gif'),
    ['https://i.imgur.com/abcde.gif']
  );
  assert.deepEqual(QIS.gifOriginals('https://i.imgur.com/abcdefg.gif'), []);
  assert.equal(QIS.upgrades('https://i.imgur.com/abcdefg.jpg').some((u) => u.endsWith('.gif')), false);
});

test('resize and format parameters are stripped off a gif', () => {
  const urls = QIS.gifOriginals('https://cdn.example.com/pics/cat.gif?w=200&format=webp&token=abc');
  assert.equal(urls[0], 'https://cdn.example.com/pics/cat.gif?token=abc');
  assert.deepEqual(
    QIS.gifOriginals('https://cdn.example.com/pics/cat.gif.webp'),
    ['https://cdn.example.com/pics/cat.gif']
  );
});

test('a twitter gif thumbnail points at the animation, not the still', () => {
  const urls = QIS.upgrades('https://pbs.twimg.com/tweet_video_thumb/AbC123.jpg');
  assert.equal(urls[0], 'https://video.twimg.com/tweet_video/AbC123.mp4');
  assert.equal(urls[1], 'https://pbs.twimg.com/tweet_video/AbC123.mp4');
});

test('gif file names prefer the page name, then the id', () => {
  const page = [{ url: 'https://media1.tenor.com/m/DEBMsntBV9gAAAAM/cat-smile.gif', verify: false }];
  const guesses = [
    { url: 'https://c.tenor.com/DEBMsntBV9gAAAAC/tenor.gif', verify: true },
    ...page
  ];
  assert.equal(QIS.gifFileName(guesses, guesses[0].url), 'cat-smile');
  assert.equal(
    QIS.gifFileName(
      [{ url: `https://media.giphy.com/media/${ID}/200w.gif`, verify: false }],
      `https://media.giphy.com/media/${ID}/source.gif`
    ),
    ID
  );
});

test('only GIF87a and GIF89a count as gif bytes', () => {
  const gif89 = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);
  const gif87 = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]);
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00]);
  assert.equal(QIS.isGifBytes(gif89), true);
  assert.equal(QIS.isGifBytes(gif87), true);
  assert.equal(QIS.isGifBytes(jpeg), false);
  assert.equal(QIS.isGifBytes(webp), false);
  assert.equal(QIS.isGifBytes(gif89.slice(0, 5)), false);
});

test('isGifUrl is the gif file, not a lookalike', () => {
  assert.equal(QIS.isGifUrl('https://cdn.example.com/a.gif'), true);
  assert.equal(QIS.isGifUrl('https://cdn.example.com/a.gif?w=10'), true);
  assert.equal(QIS.isGifUrl('https://cdn.example.com/pic?format=gif'), true);
  assert.equal(QIS.isGifUrl('https://cdn.example.com/a.gif.webp'), false);
  assert.equal(QIS.isGifUrl('https://cdn.example.com/a.jpg'), false);
  assert.equal(QIS.isGifUrl('https://video.twimg.com/tweet_video/AbC.mp4'), false);
});
