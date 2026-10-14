export interface Mp3Segment {
  offset: number;
  length: number;
  durationMs: number;
}

/**
 * Split an MP3 stream at frame boundaries into time-based segments.
 * ID3 metadata is skipped and frame bytes remain unchanged.
 */
export function parseMp3Segments(data: Uint8Array, targetMs = 5000): Mp3Segment[] {
  const bitrateV1 = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0];
  const bitrateV2 = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0];
  const sampleBase = [44100,48000,32000,0];
  const frames: Mp3Segment[] = [];
  let position = 0;

  if (data.length >= 10 && data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) {
    const tagSize = ((data[6] & 0x7f) << 21) | ((data[7] & 0x7f) << 14)
      | ((data[8] & 0x7f) << 7) | (data[9] & 0x7f);
    position = 10 + tagSize + ((data[5] & 0x10) ? 10 : 0);
  }

  while (position + 4 <= data.length) {
    if (data[position] !== 0xff || (data[position + 1] & 0xe0) !== 0xe0) {
      position++;
      continue;
    }

    const version = (data[position + 1] >> 3) & 3;
    const layer = (data[position + 1] >> 1) & 3;
    const bitrateIndex = (data[position + 2] >> 4) & 15;
    const sampleIndex = (data[position + 2] >> 2) & 3;
    const padding = (data[position + 2] >> 1) & 1;

    if (layer !== 1 || version === 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) {
      position++;
      continue;
    }

    const baseRate = sampleBase[sampleIndex];
    const sampleRate = version === 3
      ? baseRate
      : Math.floor(baseRate / (version === 2 ? 2 : 4));
    const bitrate = version === 3 ? bitrateV1[bitrateIndex] : bitrateV2[bitrateIndex];
    const frameLength = Math.floor((version === 3 ? 144000 : 72000) * bitrate / sampleRate) + padding;

    if (frameLength < 24 || position + frameLength > data.length) {
      position++;
      continue;
    }

    const samples = version === 3 ? 1152 : 576;
    frames.push({
      offset: position,
      length: frameLength,
      durationMs: (samples * 1000) / sampleRate
    });
    position += frameLength;
  }

  if (!frames.length) throw new Error('지원되는 MP3 프레임을 찾지 못했습니다.');

  const segments: Mp3Segment[] = [];
  let start = frames[0].offset;
  let length = 0;
  let durationMs = 0;

  for (const frame of frames) {
    if (durationMs > 0 && durationMs + frame.durationMs > targetMs) {
      segments.push({ offset: start, length, durationMs: Math.round(durationMs) });
      start = frame.offset;
      length = 0;
      durationMs = 0;
    }
    length += frame.length;
    durationMs += frame.durationMs;
  }

  if (length > 0) segments.push({ offset: start, length, durationMs: Math.round(durationMs) });
  return segments;
}
