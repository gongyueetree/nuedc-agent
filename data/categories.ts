/** 模块分类分类法（分层：大类 → 子类）。
 *  category 字段用 "大类.子类" 编码，如 "actuator.motor_driver"。
 *  编辑后台的分类下拉、模块选型的筛选、治理统计都读这份。 */

export interface CategoryGroup {
  key: string;        // 大类 key，如 "mcu"
  label: string;      // 中文名
  icon: string;
  children: { key: string; label: string }[];  // 子类 key 为完整 "大类.子类"
}

export const CATEGORY_TREE: CategoryGroup[] = [
  { key: "mcu", label: "控制器", icon: "🎛️", children: [
    { key: "mcu.ti_mspm0", label: "TI MSPM0" },
    { key: "mcu.stm32", label: "STM32" },
    { key: "mcu.esp32", label: "ESP32" },
    { key: "mcu.fpga", label: "FPGA / CPLD" },
    { key: "mcu.dsp", label: "DSP" },
    { key: "mcu.other", label: "其他主控" },
  ]},
  { key: "signal", label: "信号调理", icon: "〰️", children: [
    { key: "signal.dds", label: "DDS 信号源" },
    { key: "signal.vga", label: "程控增益 VGA" },
    { key: "signal.opamp", label: "运放 / 前级" },
    { key: "signal.filter", label: "滤波器" },
    { key: "signal.other", label: "其他调理" },
  ]},
  { key: "adc", label: "数据转换", icon: "🎚️", children: [
    { key: "adc.precision", label: "高精度 ADC" },
    { key: "adc.highspeed", label: "高速 ADC" },
    { key: "adc.dac", label: "DAC" },
  ]},
  { key: "sensor", label: "传感器", icon: "🌡️", children: [
    { key: "sensor.imu", label: "IMU / 姿态" },
    { key: "sensor.current", label: "电流 / 电压" },
    { key: "sensor.env", label: "环境 (温湿度/气压)" },
    { key: "sensor.distance", label: "测距 / 光电" },
    { key: "sensor.other", label: "其他传感器" },
  ]},
  { key: "vision", label: "视觉", icon: "📷", children: [
    { key: "vision.ai_camera", label: "AI 摄像头" },
    { key: "vision.camera", label: "普通摄像头" },
  ]},
  { key: "actuator", label: "执行机构", icon: "⚙️", children: [
    { key: "actuator.motor_driver", label: "电机驱动" },
    { key: "actuator.servo", label: "舵机" },
    { key: "actuator.relay", label: "继电器 / 开关" },
  ]},
  { key: "power", label: "电源管理", icon: "🔋", children: [
    { key: "power.buck", label: "降压 (Buck)" },
    { key: "power.boost", label: "升压 (Boost)" },
    { key: "power.ldo", label: "LDO / 线性" },
    { key: "power.reference", label: "基准源" },
    { key: "power.inverter", label: "逆变 / 功率级" },
  ]},
  { key: "comm", label: "通信模块", icon: "📶", children: [
    { key: "comm.wireless_2g4", label: "2.4G 无线" },
    { key: "comm.wifi_ble", label: "WiFi / BLE" },
    { key: "comm.lora", label: "LoRa" },
    { key: "comm.wired", label: "有线 (CAN/RS485)" },
  ]},
  { key: "display", label: "显示与人机交互", icon: "🖥️", children: [
    { key: "display.screen", label: "屏幕 (TFT/OLED)" },
    { key: "display.hmi", label: "按键 / 编码器 / 触摸" },
  ]},
  { key: "magnetics", label: "磁性器件", icon: "🧲", children: [
    { key: "magnetics.core", label: "磁环 / 磁芯" },
    { key: "magnetics.transformer", label: "变压器 / 电感" },
  ]},
  { key: "robot", label: "机器人与运动平台", icon: "🤖", children: [
    { key: "robot.chassis", label: "底盘 / 车体" },
    { key: "robot.gimbal", label: "云台 / 机械臂" },
    { key: "robot.aircraft", label: "飞行平台" },
  ]},
  { key: "protect", label: "安全保护与连接", icon: "🛡️", children: [
    { key: "protect.protection", label: "保护 (过流/隔离/TVS)" },
    { key: "protect.connector", label: "连接器 / 线缆" },
  ]},
  { key: "instrument", label: "测试仪表与校准", icon: "📏", children: [
    { key: "instrument.meter", label: "测量前端 / 表头" },
    { key: "instrument.calibration", label: "校准 / 基准" },
  ]},
  { key: "other", label: "其他", icon: "🔲", children: [
    { key: "other.mechanical", label: "机械结构 / 耗材" },
    { key: "other.misc", label: "杂项" },
  ]},
];

export const CAT_ICON: Record<string, string> = Object.fromEntries(
  CATEGORY_TREE.map((g) => [g.key, g.icon])
);

/** 完整 category → 中文路径，如 "actuator.motor_driver" → "执行机构 / 电机驱动" */
export function categoryLabel(cat: string): string {
  const [top] = String(cat).split(".");
  const g = CATEGORY_TREE.find((x) => x.key === top);
  if (!g) return cat;
  const child = g.children.find((c) => c.key === cat);
  return child ? `${g.label} / ${child.label}` : g.label;
}

/** 扁平的完整分类列表（编辑表单下拉用） */
export const FLAT_CATEGORIES = CATEGORY_TREE.flatMap((g) =>
  g.children.map((c) => ({ value: c.key, label: `${g.label} / ${c.label}` }))
);

export const PROTOCOL_ENUM = ["I2C","SPI","UART","GPIO","ADC","DAC","PWM","USB","CAN","RS485","I2S","PDM","SDIO","RS232","OneWire","WiFi","BLE","LoRa","Zigbee","NFC","CSI","DVP"] as const;
export const CERT_STATES = ["DRAFT","DOCUMENTED","POWER_TESTED","FUNCTION_TESTED","BENCHMARKED","COMPETITION_READY","DEPRECATED"] as const;
export const SOURCE_TYPES = ["taobao","lab","official","opensource"] as const;
