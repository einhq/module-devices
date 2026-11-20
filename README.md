# module-devices

Drivers for EiN's devices, and what they need beside EiN. The `devices-bridge` service listens on an MQTT broker
and drives what it hears as devices under `/dev`: `ha-discovery` for anything that announces itself
the way Home Assistant reads (ESPHome, Zigbee2MQTT), `shelly` for Shelly's second generation and
later, `shelly-gen1` for the first (Plug S, 1, 1PM, 2.5, i3). Their readings and presses become the devices' endpoints, published on `dev.<device>.<endpoint>`
for queues and logs to take, and a value written to a control (`echo on > /dev/hall-plug/switch-0`)
is sent to the device.

Devices that are on the network but not yet on the broker are found too. A listener beside the
broker on the host's own network (the sidecar, below) asks mDNS and SSDP what is there and publishes each address it heard as a retained message under
`ein/discovery/host/<id>`, with its own `ein/discovery/status`. The bridge keeps those:
`devices-found` names each one (a Shelly, ESPHome, a HomeKit or Matter accessory, a Hue bridge,
a speaker, a printer, …), says whether it is a device already and, given one, shows all the
listener heard of it. `devices-adopt` adds one: a Shelly's MQTT is pointed at the broker and it
is restarted, so its driver takes it; anything else becomes a device of a driver that asks it
itself, over the network: `ipp` for a printer (state, warnings, ink and toner), `cast` for a Google
Cast speaker or screen and `dlna` for a DLNA renderer, a TV say (what it plays; volume, mute, play,
pause and stop; and the recordings, videos, pictures and pages whose paths are written to its
`show`, played or shown on it, `play.ts`; `devices-nearby` makes a recording or video the same way
for a screen near a browser, which core's `CFG_FILE_STREAMER` names, `nearby.ts`), `onvif` for a camera that answers ONVIF, `snmp` for a NAS or anything
else that answers SNMP (uptime, load, memory, each volume's use, temperatures; the community is
`CFG_DEVICES_SNMP_COMMUNITY`), and `network` for the rest (whether it answers, and how fast).
`devices-snmp <host> [oid]` walks what a device's agent answers. The `rtsp` driver takes a
camera that sends its picture over RTSP, made by hand with `device-create 'Front door' --driver rtsp
--config url=rtsp://… [--config sub=…] [--config user=…] --config password=…` (the password is the
device's `.secret`): its profiles, `main` and `sub`, go to the restreamer (`CFG_DEVICES_STREAMS_URL`,
the sidecar's go2rtc) as `<device>-<profile>`, again whenever the restreamer lacks one, and are each
two core `stream` endpoints, which the bridge writes from the restreamer while anyone reads them:
`main.ts` and `sub.ts`, MPEG-TS, through which the media service watches a camera it is granted,
and `main.mp4` and `sub.mp4`, fragmented MP4, cut into its header and fragments (`@ems/live/split`).
Each profile also has a picture node, `main.jpg` and `sub.jpg`, a core stream of pictures: reading
one gives the latest picture, and the bridge makes a picture only while someone waits for one, the
media service's first frame of the profile's MPEG-TS, or without a restreamer the camera's still
picture (`--config snapshot=…`). The **Live** tab on a camera's page reads the MP4 one over
`GET /file/…` into a MediaSource; a browser that does not play its codec (HEVC) reads a
transcode of it the media service makes for the page (`stream-transcode`). The `http` driver asks a web
API that answers JSON, made by hand with `device-create <name> --driver http --config url=… --config
read=…`: a device on the network with an API of its own, the weather, the price of electricity, each
reading a path in the answer (`temperature=current.temperature_2m °C`,
`price=[time_start..time_end].SEK_per_kWh`), and `--config set=…` the controls, each an address asked
to set it (`pump=api/pump?run={value} 1/0`). `devices-ignore` leaves one out. The Devices page shows how
many can be added, and opens them as a page of their own.

The devices, their pages and the device commands are EiN core's; this module brings the drivers, the
cameras' live view, the dashboard's camera and button cards, and the settings of the broker and
the restreamer. Rules that act on devices are the automation module's.

`sidecar/` is the image of what the module's devices need beside EiN, `ghcr.io/einhq/devices`,
which EiN's deployment runs with `setup.sh --devices`: the MQTT broker (Mosquitto), the network
listener (`discovery.ts`) and a restreamer for cameras (go2rtc), in one container on the host's
network under a small supervisor (`supervisor.ts`, which says what each reads). GitHub builds it when
a push to main changes the folder.

An [EiN](https://github.com/einhq) module. It is developed and tested inside a checkout of EiN core,
as `modules/devices`, and a deployment chooses whether to run it.
