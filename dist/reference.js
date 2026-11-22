export const referenceImage = './assets/raspberry-pi-4.webp';
export const referenceName = 'Raspberry Pi 4 Model B';
export const referenceAnchors = [
  {
    id: 'hdmi0',
    label: 'Micro-HDMI 0',
    group: 'Display',
    icon: 'hdmi-port',
    x: 0.553,
    y: 0.761,
    note: 'Connect your first monitor to HDMI0, the micro-HDMI socket closest to the USB-C power port.',
  },
  {
    id: 'usb_c',
    label: 'USB-C power',
    group: 'Power',
    icon: 'plug-zap',
    x: 0.46,
    y: 0.819,
    note: 'Connect the board’s USB-C power supply here. This port sits beside the two micro-HDMI outputs.',
  },
  {
    id: 'ethernet',
    label: 'Ethernet',
    group: 'Network',
    icon: 'ethernet-port',
    x: 0.704,
    y: 0.261,
    note: 'Plug an Ethernet cable into this metal jack for a wired network connection.',
  },
  {
    id: 'usb3',
    label: 'USB 3.0',
    group: 'Data',
    icon: 'usb',
    x: 0.775,
    y: 0.349,
    note: 'Use either port in the blue USB-A stack for a USB 3 device, such as an external drive.',
  },
];
