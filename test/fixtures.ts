/**
 * Messages as real devices send them, with invented names and addresses: an ESPHome sensor in the
 * hall announcing itself with Home Assistant's abbreviated keys, a Shelly plug and a Shelly
 * four-button input by the porch; and devices answering as they do: a printer's IPP, an SNMP agent,
 * a TV's DLNA renderer.
 */

import dgram from 'node:dgram';

export type Message = { topic: string; payload: string; retain?: boolean };

const esphomeDevice = {
  ids: 'a4cf12000001',
  name: 'hall-sensor',
  sw: '2025.10.0 (ESPHome)',
  mdl: 'esp32dev',
  mf: 'Espressif',
  cns: [['mac', 'a4cf12000001']],
  cu: 'http://192.0.2.22',
};

/** The hall sensor's announcements, retained as ESPHome sends them. */
export const esphomeConfigs: Message[] = [
  {
    topic: 'homeassistant/sensor/hall-sensor/temperature/config',
    retain: true,
    payload: JSON.stringify({
      dev_cla: 'temperature',
      unit_of_meas: '°C',
      stat_cla: 'measurement',
      name: 'Temperature',
      stat_t: 'hall-sensor/sensor/temperature/state',
      avty_t: 'hall-sensor/status',
      uniq_id: 'ESPsensortemperature',
      dev: esphomeDevice,
    }),
  },
  {
    topic: 'homeassistant/binary_sensor/hall-sensor/motion/config',
    retain: true,
    payload: JSON.stringify({
      dev_cla: 'motion',
      name: 'Motion',
      stat_t: 'hall-sensor/binary_sensor/motion/state',
      avty_t: 'hall-sensor/status',
      uniq_id: 'ESPbinary_sensormotion',
      dev: esphomeDevice,
    }),
  },
  {
    topic: 'homeassistant/switch/hall-sensor/relay/config',
    retain: true,
    payload: JSON.stringify({
      name: 'Relay',
      stat_t: 'hall-sensor/switch/relay/state',
      cmd_t: 'hall-sensor/switch/relay/command',
      avty_t: 'hall-sensor/status',
      uniq_id: 'ESPswitchrelay',
      dev: esphomeDevice,
    }),
  },
];

export const esphomeStates: Message[] = [
  { topic: 'hall-sensor/status', payload: 'online', retain: true },
  { topic: 'hall-sensor/sensor/temperature/state', payload: '21.4', retain: true },
  { topic: 'hall-sensor/binary_sensor/motion/state', payload: 'OFF', retain: true },
  { topic: 'hall-sensor/switch/relay/state', payload: 'ON', retain: true },
];

/** A bedroom sensor announced the way Zigbee2MQTT does: one JSON state read with templates. */
export const templatedConfig: Message = {
  topic: 'homeassistant/sensor/0x00158d0000000001/humidity/config',
  retain: true,
  payload: JSON.stringify({
    name: 'Humidity',
    unit_of_measurement: '%',
    device_class: 'humidity',
    state_topic: 'zigbee2mqtt/bedroom',
    value_template: '{{ value_json.humidity | round(1) }}',
    unique_id: '0x00158d0000000001_humidity',
    device: { identifiers: ['zigbee2mqtt_0x00158d0000000001'], name: 'bedroom', model: 'Temperature and humidity sensor' },
  }),
};

export const shellyPlug = {
  online: { topic: 'hall-plug/online', payload: 'true', retain: true },
  switchStatus: {
    topic: 'hall-plug/status/switch:0',
    payload: JSON.stringify({
      id: 0,
      source: 'init',
      output: true,
      apower: 12.3,
      voltage: 231.2,
      current: 0.06,
      aenergy: { total: 1520.5, by_minute: [0, 0, 0], minute_ts: 1700000000 },
      temperature: { tC: 31.2, tF: 88.2 },
    }),
  },
  sysStatus: { topic: 'hall-plug/status/sys', payload: JSON.stringify({ mac: 'A8032AB12345', uptime: 3600 }) },
  powerChange: {
    topic: 'hall-plug/events/rpc',
    payload: JSON.stringify({
      src: 'shellyplugsg3-a8032ab12345',
      dst: 'hall-plug/events',
      method: 'NotifyStatus',
      params: { ts: 1700000001, 'switch:0': { id: 0, apower: 20.5 } },
    }),
  },
  deviceInfo: (src: string, id: number) => ({
    topic: `${src}/rpc`,
    payload: JSON.stringify({
      id,
      src: 'shellyplugsg3-a8032ab12345',
      dst: src,
      result: { name: 'Hall plug', id: 'shellyplugsg3-a8032ab12345', mac: 'A8032AB12345', model: 'S3PL-00112EU', gen: 3, ver: '1.4.4', app: 'PlugSG3' },
    }),
  }),
};

export const shellyButton = {
  press: {
    topic: 'porch-button/events/rpc',
    payload: JSON.stringify({
      src: 'shellyplusi4-c8f09e000001',
      dst: 'porch-button/events',
      method: 'NotifyEvent',
      params: { ts: 1700000002.5, events: [{ component: 'input:0', id: 0, event: 'single_push', ts: 1700000002.5 }] },
    }),
  },
  longPress: {
    topic: 'porch-button/events/rpc',
    payload: JSON.stringify({
      src: 'shellyplusi4-c8f09e000001',
      dst: 'porch-button/events',
      method: 'NotifyEvent',
      params: { ts: 1700000003.5, events: [{ component: 'input:0', id: 0, event: 'long_push', ts: 1700000003.5 }] },
    }),
  },
};

/**
 * A first generation Plug S as it says itself on connecting and after, recorded from one and given
 * an invented id, MAC and address.
 */
export const shellyGen1Plug = {
  id: 'shellyplug-s-a1b2c3d4e5f6',
  announce: {
    topic: 'shellies/announce',
    payload: JSON.stringify({
      id: 'shellyplug-s-a1b2c3d4e5f6',
      model: 'SHPLG-S',
      mac: 'A1B2C3D4E5F6',
      ip: '192.0.2.10',
      new_fw: false,
      fw_ver: '20221027-101131/v1.12.1-ga9117d3',
    }),
  },
  online: { topic: 'shellies/shellyplug-s-a1b2c3d4e5f6/online', payload: 'true' },
  relay: { topic: 'shellies/shellyplug-s-a1b2c3d4e5f6/relay/0', payload: 'on' },
  power: { topic: 'shellies/shellyplug-s-a1b2c3d4e5f6/relay/0/power', payload: '8.46' },
  energy: { topic: 'shellies/shellyplug-s-a1b2c3d4e5f6/relay/0/energy', payload: '120' },
  temperature: { topic: 'shellies/shellyplug-s-a1b2c3d4e5f6/temperature', payload: '27.90' },
  command: { topic: 'shellies/shellyplug-s-a1b2c3d4e5f6/relay/0/command', payload: 'off' },
};

/** A second generation colour light (`rgbw:0`) and a cover (`cover:0`), as their status says them. */
export const shellyColorLight = {
  status: {
    topic: 'desk-lamp/status/rgbw:0',
    payload: JSON.stringify({ id: 0, source: 'init', output: true, brightness: 40, rgb: [255, 128, 0], white: 10, apower: 6.1 }),
  },
};

export const shellyCover = {
  status: {
    topic: 'kitchen-blind/status/cover:0',
    payload: JSON.stringify({ id: 0, source: 'init', state: 'stopped', apower: 0, current_pos: 30, pos_control: true }),
  },
};

/** A first generation Duo RGBW in colour mode and a 2.5 in roller mode, with invented ids. */
export const shellyGen1Light = {
  id: 'shellycolorbulb-a1b2c3d4e5f7',
  light: { topic: 'shellies/shellycolorbulb-a1b2c3d4e5f7/color/0', payload: 'on' },
  status: {
    topic: 'shellies/shellycolorbulb-a1b2c3d4e5f7/color/0/status',
    payload: JSON.stringify({ ison: true, mode: 'color', red: 0, green: 128, blue: 255, white: 0, gain: 70, brightness: 30, temp: 4750, effect: 0 }),
  },
};

export const shellyGen1Roller = {
  id: 'shellyswitch25-a1b2c3d4e5f8',
  state: { topic: 'shellies/shellyswitch25-a1b2c3d4e5f8/roller/0', payload: 'stop' },
  position: { topic: 'shellies/shellyswitch25-a1b2c3d4e5f8/roller/0/pos', payload: '-1' },
};

/** An IPP response: success, and the printer attributes given, each value tagged as its type is. */
export const ippResponse = (attributes: [number, string, (string | number)[]][]): Uint8Array<ArrayBuffer> => {
  const bytes = [2, 0, 0, 0, 0, 0, 0, 1, 0x04];
  for (const [tag, name, values] of attributes) {
    values.forEach((value, index) => {
      const key = index === 0 ? new TextEncoder().encode(name) : new Uint8Array();
      const data = typeof value === 'number' ? [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff] : [...new TextEncoder().encode(value)];
      bytes.push(tag, key.length >> 8, key.length & 0xff, ...key, data.length >> 8, data.length & 0xff, ...data);
    });
  }
  return new Uint8Array([...bytes, 0x03]);
};

type AgentObject = [oid: string, type: 'int' | 'gauge' | 'ticks' | 'string' | 'oid', value: number | string];

/**
 * An SNMPv2c agent on this machine's loopback answering GET and GETBULK from `objects` for the
 * community `public`, and nothing for any other: enough of an agent for the snmp driver.
 */
export const startSnmpAgent = (objects: AgentObject[]): { ready: Promise<number>; close(): void } => {
  const key = (oid: string) => oid.split('.').map((part) => part.padStart(10, '0')).join('.');
  const sorted = [...objects].sort((a, b) => key(a[0]).localeCompare(key(b[0])));
  const length = (n: number) => n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  const tlv = (tag: number, body: number[]) => [tag, ...length(body.length), ...body];
  const int = (n: number) => {
    const bytes: number[] = [];
    do {
      bytes.unshift(n & 0xff);
      n = Math.floor(n / 256);
    } while (n > 0 || bytes[0] & 0x80);
    return bytes;
  };
  const oid = (text: string) => {
    const parts = text.split('.').map(Number);
    const bytes = [parts[0] * 40 + parts[1]];
    for (const part of parts.slice(2)) {
      const chunk = [part & 0x7f];
      for (let rest = part >> 7; rest > 0; rest >>= 7) chunk.unshift((rest & 0x7f) | 0x80);
      bytes.push(...chunk);
    }
    return bytes;
  };
  const value = ([, type, v]: AgentObject) =>
    type === 'string'
      ? tlv(0x04, [...new TextEncoder().encode(String(v))])
      : type === 'oid'
      ? tlv(0x06, oid(String(v)))
      : tlv({ int: 0x02, gauge: 0x42, ticks: 0x43 }[type], int(Number(v)));
  const read = (bytes: Uint8Array, at: number) => {
    let len = bytes[at + 1], start = at + 2;
    if (len & 0x80) {
      const count = len & 0x7f;
      len = 0;
      for (let i = 0; i < count; i++) len = len * 256 + bytes[start + i];
      start += count;
    }
    return { tag: bytes[at], body: bytes.subarray(start, start + len), end: start + len };
  };
  const all = (body: Uint8Array) => {
    const out = [];
    for (let at = 0; at < body.length;) {
      const element = read(body, at);
      out.push(element);
      at = element.end;
    }
    return out;
  };
  const oidText = (body: Uint8Array) => {
    const parts = [Math.floor(body[0] / 40), body[0] % 40];
    let n = 0;
    for (const byte of body.subarray(1)) {
      n = n * 128 + (byte & 0x7f);
      if (!(byte & 0x80)) parts.push(n), n = 0;
    }
    return parts.join('.');
  };
  const socket = dgram.createSocket('udp4');
  socket.on('message', (bytes: Uint8Array, from: { address: string; port: number }) => {
    const [, community, pdu] = all(read(bytes, 0).body);
    if (new TextDecoder().decode(community.body) !== 'public') return;
    const [id, , repetitions, list] = all(pdu.body);
    const asked = all(list.body).map((varbind) => oidText(all(varbind.body)[0].body));
    const answers: number[] = [];
    for (const each of asked) {
      if (pdu.tag === 0xa0) {
        const found = sorted.find((object) => object[0] === each);
        answers.push(...tlv(0x30, [...tlv(0x06, oid(each)), ...(found ? value(found) : [0x81, 0])]));
      } else {
        const after = sorted.filter((object) => key(object[0]) > key(each)).slice(0, repetitions.body[0] || 10);
        for (const object of after) answers.push(...tlv(0x30, [...tlv(0x06, oid(object[0])), ...value(object)]));
        if (after.length === 0) answers.push(...tlv(0x30, [...tlv(0x06, oid(each)), 0x82, 0]));
      }
    }
    const response = tlv(0xa2, [...tlv(0x02, [...id.body]), 0x02, 1, 0, 0x02, 1, 0, ...tlv(0x30, answers)]);
    socket.send(new Uint8Array(tlv(0x30, [0x02, 1, 1, ...tlv(0x04, [...community.body]), ...response])), from.port, from.address);
  });
  const ready = new Promise<number>((resolve) => socket.bind(0, '127.0.0.1', () => resolve(socket.address().port)));
  return { ready, close: () => socket.close() };
};

/** A DLNA renderer's description, as the 2014 Philips TV of ein/core#1328 gave it: the renderer inside a root device. */
export const RENDERER_DESCRIPTION = `<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0">
<device><deviceType>urn:schemas-upnp-org:device:Basic:1</deviceType><friendlyName>TV</friendlyName>
<deviceList><device>
<deviceType>urn:schemas-upnp-org:device:MediaRenderer:3</deviceType><friendlyName>PHILIPS TV</friendlyName>
<UDN>uuid:0d1e2a3b-4c5d-1e6f-8a7b-020000000050</UDN>
<serviceList>
<service><serviceType>urn:schemas-upnp-org:service:RenderingControl:3</serviceType><controlURL>control/RenderingControl</controlURL></service>
<service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:3</serviceType><controlURL>control/ConnectionManager</controlURL></service>
<service><serviceType>urn:schemas-upnp-org:service:AVTransport:3</serviceType><controlURL>/control/AVTransport</controlURL></service>
</serviceList></device></deviceList></device></root>`;

/** What it plays, from its `GetProtocolInfo`, shortened. */
export const RENDERER_SINK = 'http-get:*:image/jpeg:DLNA.ORG_PN=JPEG_LRG,http-get:*:audio/L16;rate=44100;channels=2:DLNA.ORG_PN=LPCM,' +
  'http-get:*:audio/mpeg:DLNA.ORG_PN=MP3,http-get:*:audio/mp4:DLNA.ORG_PN=AAC_ISO,http-get:*:video/mp4:DLNA.ORG_PN=AVC_MP4_HP_HD_AAC';

const envelope = (inner: string) => `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${inner}</s:Body></s:Envelope>`;
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A DLNA renderer on this machine's loopback, at `hostname`, that answers as that TV did: its
 * description at `/dmr.xml`, its transport held through the first `SetAVTransportURI` after a stop
 * (UPnP 705), the title only with the whole medium (`GetMediaInfo`). Answers what it was asked, and
 * its state.
 */
export const startRenderer = (hostname = '127.0.0.1') => {
  const asked: { action: string; soapaction: string; body: string }[] = [];
  const state = { uri: '', metadata: '', transport: 'NO_MEDIA_PRESENT', volume: 12, locked: 1 };
  const server = Deno.serve({ hostname, port: 0, onListen: () => {} }, async (req) => {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/dmr.xml') return new Response(RENDERER_DESCRIPTION, { headers: { 'content-type': 'text/xml' } });
    const body = await req.text();
    const action = body.match(/<u:(\w+) /)?.[1] ?? '';
    asked.push({ action, soapaction: req.headers.get('soapaction') ?? '', body });
    const field = (name: string) => body.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1] ?? '';
    const answer = (inner = '') => new Response(envelope(`<u:${action}Response xmlns:u="urn:x">${inner}</u:${action}Response>`));
    switch (action) {
      case 'Stop':
        state.transport = 'STOPPED';
        return answer();
      case 'SetAVTransportURI':
        if (state.locked-- > 0) {
          return new Response(
            envelope('<s:Fault><detail><UPnPError><errorCode>705</errorCode><errorDescription>Transport is locked</errorDescription></UPnPError></detail></s:Fault>'),
            {
              status: 500,
            },
          );
        }
        state.uri = field('CurrentURI').replace(/&amp;/g, '&');
        state.metadata = field('CurrentURIMetaData');
        return answer();
      case 'Play':
        state.transport = 'PLAYING';
        return answer();
      case 'GetTransportInfo':
        return answer(`<CurrentTransportState>${state.transport}</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus>`);
      case 'GetPositionInfo':
        return answer(
          `<TrackDuration>0:03:20</TrackDuration><TrackMetaData>NOT_IMPLEMENTED</TrackMetaData><TrackURI>${escape(state.uri)}</TrackURI><RelTime>0:01:02.500</RelTime>`,
        );
      case 'GetMediaInfo':
        return answer(`<NrTracks>1</NrTracks><CurrentURI>${escape(state.uri)}</CurrentURI><CurrentURIMetaData>${state.metadata}</CurrentURIMetaData>`);
      case 'GetVolume':
        return answer(`<CurrentVolume>${state.volume}</CurrentVolume>`);
      case 'SetVolume':
        state.volume = Number(field('DesiredVolume'));
        return answer();
      case 'GetMute':
        return answer('<CurrentMute>0</CurrentMute>');
      case 'GetProtocolInfo':
        // The TV refuses an InstanceID here, which ConnectionManager's actions do not take.
        if (body.includes('<InstanceID>')) {
          return new Response(
            envelope('<s:Fault><detail><UPnPError><errorCode>402</errorCode><errorDescription>Invalid Args</errorDescription></UPnPError></detail></s:Fault>'),
            {
              status: 500,
            },
          );
        }
        return answer(`<Source></Source><Sink>${RENDERER_SINK}</Sink>`);
      default:
        return new Response(envelope('<s:Fault><detail><UPnPError><errorCode>401</errorCode></UPnPError></detail></s:Fault>'), { status: 500 });
    }
  });
  return { asked, state, location: `http://${hostname}:${server.addr.port}/dmr.xml`, stop: () => server.shutdown() };
};
