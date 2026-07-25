import { z } from "zod";
import { MODULE_CERT_STATES } from "./types";

// 与 eehubio/ai-hardware-genesis-platform 的枚举保持一致，便于两库互导
const PROTOCOL_ENUM = ["I2C","SPI","UART","GPIO","ADC","DAC","PWM","USB","CAN","RS485","I2S","PDM","SDIO","RS232","OneWire","WiFi","BLE","LoRa","Zigbee","NFC","CSI","DVP"] as const;

export const interfaceSchema = z.object({
  interface_id: z.string().optional(),
  name: z.string(),                                 // "UART1"
  interface_type: z.enum(PROTOCOL_ENUM),
  role: z.enum(["host", "device", "peer", "either"]).default("either"),
  voltage_level: z.number().optional(),             // 逻辑电平 V
  five_v_tolerant: z.boolean().optional(),
  max_baudrate: z.number().optional(),
  address: z.string().regex(/^0x[0-9a-fA-F]{2}$/).optional(),
  pins: z.array(z.object({ signal: z.string(), pin: z.string() })).default([]),
  constraints: z.array(z.string()).default([]),
});

export const powerSchema = z.object({
  input_voltage_range: z.tuple([z.number(), z.number()]).optional(),
  recommended_voltage: z.number().optional(),
  typical_current_ma: z.number().optional(),
  peak_current_ma: z.number().optional(),
  can_source_power: z.boolean().optional(),
  output_capability_ma: z.number().optional(),
  has_onboard_regulator: z.boolean().optional(),
}).passthrough();

// 淘宝快照：商品会下架换芯片，数据库核心是模块本身而不是商品页
export const sourceSnapshotSchema = z.object({
  source: z.enum(["taobao", "lab", "official", "opensource"]),
  source_url: z.string().optional(),
  seller: z.string().optional(),
  captured_at: z.string().optional(),
  product_title: z.string().optional(),
  claimed_chip: z.string().optional(),
  identified_chip: z.string().optional(),
  price_snapshot: z.record(z.any()).optional(),
  uploader: z.string().optional(),                  // 实验室上传者
  school: z.string().optional(),
});

// 参数证据等级（诊断 4.4）：E0 AI 推断 → E6 多实验室复验
export const EVIDENCE_LEVELS = ["E0", "E1", "E2", "E3", "E4", "E5", "E6"] as const;
export const evidenceRecordSchema = z.object({
  param: z.string(),                       // 参数路径，如 "power.peak_current_ma"
  value: z.union([z.number(), z.string()]),
  unit: z.string().optional(),
  evidence_level: z.enum(EVIDENCE_LEVELS), // E0 AI推断/E1 商家/E2 社区/E3 芯片手册/E4 模块厂/E5 单实验室实测/E6 多实验室复验
  source_id: z.string().optional(),        // 测试记录/手册页码
  conditions: z.string().optional(),       // "12V, 25°C, 无风扇"
  confidence: z.number().min(0).max(1).optional(),
});

export const moduleInputSchema = z.object({
  id: z.string().min(2).regex(/^[a-z0-9_\-]+$/, "id 只能包含小写字母、数字、下划线或连字符"),
  name: z.string().min(1),
  category: z.string().min(1),                      // "actuator.motor_driver" 等分层分类
  version: z.string().default("1.0.0"),
  description: z.string().default(""),
  principle: z.string().optional(),                 // 工作原理
  main_chip: z.string().optional(),

  interfaces: z.array(interfaceSchema).default([]),
  power: powerSchema.optional(),
  physical: z.object({
    width_mm: z.number().optional(),
    height_mm: z.number().optional(),
    weight_g: z.number().optional(),
  }).passthrough().optional(),

  // 资产：原理图 / PCB / 图片 / 代码仓库 —— 存 URI，付费门控在 API 层
  schematic_assets: z.array(z.string()).default([]),
  pcb_assets: z.array(z.string()).default([]),
  images: z.array(z.string()).default([]),
  // 归属字段：服务端按 identity 覆盖，客户端传值不作数
  scope: z.enum(["PERSONAL", "TEAM", "ORGANIZATION", "PUBLIC"]).default("PUBLIC").optional(),
  owner_ref: z.string().nullish(),
  org_ref: z.string().nullish(),
  code_repositories: z.array(z.string()).default([]),
  datasheet_url: z.string().optional(),

  usage_notes: z.array(z.string()).default([]),     // 注意事项
  known_issues: z.array(z.string()).default([]),    // 常见 Bug
  compatibility: z.array(z.string()).default([]),   // 兼容/可替换模块 id
  competition_cases: z.array(z.object({             // 历届电赛应用
    year: z.number(), problem: z.string(), note: z.string().optional(),
  })).default([]),

  evidence_records: z.array(evidenceRecordSchema).default([]),
  certification_status: z.enum(MODULE_CERT_STATES).default("DRAFT"),
  source_snapshot: sourceSnapshotSchema.optional(),
  price: z.number().nonnegative().default(0),
  tags: z.array(z.string()).default([]),
});

export type ModuleInput = z.infer<typeof moduleInputSchema>;
export const moduleUpdateSchema = moduleInputSchema.partial().omit({ id: true });

export function zodMessage(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}
