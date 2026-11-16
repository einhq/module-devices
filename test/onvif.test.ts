/**
 * The ONVIF client against a stub camera, and what the driver reads of its answers: a request is
 * signed with the camera's clock, a wrong password is said as such, a reference parameter goes back
 * with its namespace, and a camera's events are sorted into kinds by their topic.
 */

import { assertEquals, assertRejects } from '@std/assert';
import { eventKind, eventState, eventValue } from '../lib/cameras/onvif-driver.ts';
import { createOnvif, deviceServiceUrl, OnvifFault } from '../lib/cameras/onvif.ts';
import { find, parseXml, writeXml } from '../lib/cameras/xml.ts';
import { startOnvifCamera } from './onvif-camera.ts';

Deno.test('a camera is asked at its device service, with its own clock, and a wrong password is said', async () => {
  const camera = startOnvifCamera({ user: 'admin', password: 's3cret', clockOffsetMs: -10 * 60_000 });
  try {
    assertEquals(deviceServiceUrl('192.0.2.10:8000'), 'http://192.0.2.10:8000/onvif/device_service');
    assertEquals(deviceServiceUrl('https://192.0.2.10/onvif/device'), 'https://192.0.2.10/onvif/device');
    const onvif = createOnvif(fetch, camera.address(), 'admin', 's3cret');
    assertEquals(await onvif.info(), { manufacturer: 'Acme', model: 'Dome 4', firmware: 'v2.1', serial: 'AC0001' });
    assertEquals((await onvif.profiles()).map((profile) => [profile.token, profile.codec, profile.width, profile.ptz]), [
      ['sub', 'h264', 640, undefined],
      ['main', 'h265', 2560, { panTilt: true, zoom: true }],
    ]);
    assertEquals(await onvif.snapshotUri('main'), `http://${camera.address()}/snapshot/main.jpg`);
    const refused = await assertRejects(() => createOnvif(fetch, camera.address(), 'admin', 'wrong').info(), OnvifFault);
    assertEquals([refused.code, refused.message], ['NotAuthorized', "the camera refused admin's password"]);
  } finally {
    await camera.server.shutdown();
  }
});

Deno.test('XML is read by local names, and an element written back keeps its namespace', () => {
  const doc = parseXml(
    '<?xml version="1.0"?><!-- a camera --><s:Envelope xmlns:s="urn:s"><s:Body><a:Ref xmlns:a="urn:a"><b:Id xmlns:b="urn:b">7 &amp; 8</b:Id>' +
      '<Note><![CDATA[<raw>]]></Note></a:Ref></s:Body></s:Envelope>',
  );
  const ref = find(doc, 'Ref')!;
  assertEquals([ref.ns, find(ref, 'Id')?.text, find(ref, 'Note')?.text], ['urn:a', '7 & 8', '<raw>']);
  assertEquals(writeXml(find(ref, 'Id')!), '<b:Id xmlns:b="urn:b">7 &amp; 8</b:Id>');
});

Deno.test("a camera's events are sorted by their topic, and are a state or, for a line crossed, an event", () => {
  assertEquals(
    [
      'RuleEngine/CellMotionDetector/Motion',
      'VideoSource/MotionAlarm',
      'RuleEngine/PeopleDetector/People',
      'RuleEngine/MyRuleDetector/HumanDetect',
      'RuleEngine/MyRuleDetector/VehicleDetect',
      'RuleEngine/MyRuleDetector/DogCatDetect',
      'RuleEngine/TamperDetector/Tamper',
      'VideoSource/GlobalSceneChange/ImagingService',
      'AudioAnalytics/Audio/DetectedSound',
      'RuleEngine/LineDetector/Crossed',
      'RuleEngine/FieldDetector/ObjectsInside',
      'Device/HardwareFailure/StorageFailure',
      'Device/Trigger/DigitalInput',
    ].map((topic) => eventKind(topic)?.kind),
    ['motion', 'motion', 'person', 'person', 'vehicle', 'animal', 'tamper', 'tamper', 'sound', 'line-crossing', 'intrusion', 'storage-failure', undefined],
  );
  assertEquals(
    ([{ IsMotion: 'true' }, { State: 'false' }, { Rule: 'MyRule', IsPeople: '1' }, { Region: 'A' }] as Record<string, string>[]).map((data) =>
      eventState({ topic: '', data })
    ),
    [true, false, true, undefined],
  );
  const crossed = eventKind('RuleEngine/LineDetector/Crossed')!;
  assertEquals(
    ([{ ObjectId: '0' }, { ObjectId: '1' }, {}, { State: 'false' }] as Record<string, string>[]).map((data) => eventValue(crossed, { topic: '', data })),
    ['crossed', 'crossed', 'crossed', undefined],
  );
  assertEquals(eventValue(eventKind('Device/HardwareFailure/StorageFailure')!, { topic: '', data: { Failed: 'true' } }), true);
});
