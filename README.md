# AI Image Prompt Saver

保存 AI 生成图片时，自动将提示词、模型等溯源信息写入图片元数据，  
格式兼容 ComfyUI / A1111 生态，可被主流 AI 绘画工具识别和复现。

## 特性

- 🖼️ 一键保存：在生成图片上注入"💾 保存"按钮，点击即保存
- 📝 元数据完整：写入提示词、模型、生成时间、来源 URL
- 🔄 生态兼容：同时写入 A1111 parameters 和自定义 AIP\_* 字段
- 👁️ 内置查看器：点扩展图标即可打开图片，右侧显示提示词
- 🌐 中文友好：iTXt（PNG）/ EXIF UserComment（JPEG）UTF-8 编码
- 🚫 零依赖：核心元数据读写自己实现，不引第三方库

## 支持的平台

| 平台                      | 状态      | 备注       |
| ----------------------- | ------- | -------- |
| 文心助手 (wenxin.baidu.com) | ✅ 已支持   | v0.1.0   |
| ChatGPT                 | 🚧 计划中  |          |
| 即梦                      | 🚧 计划中  |          |
| 更多平台                    | 🚧 欢迎贡献 | 见下方适配器架构 |

## 安装（开发版）

1. 克隆仓库并安装依赖：
   ```bash
   git clone https://github.com/1045492349/ai-image-prompt-saver.git
   cd ai-image-prompt-saver
   npm install
   npm run build
   ```
2. 在 Edge / Chrome 加载扩展：
   - Edge：打开 `edge://extensions/`，开启左下角"开发人员模式"，  
     点"加载解压缩的扩展"，选择 `dist/` 目录
   - Chrome：打开 `chrome://extensions/`，开启右上角"开发者模式"，  
     点"加载已解压的扩展程序"，选择 `dist/` 目录

## 使用

1. 打开文心助手（<https://wenxin.baidu.com/），生成一张图片>
2. 图片下方会出现"💾 保存"按钮，点击即可保存
3. 保存的 JPEG 会自动写入提示词和元数据
4. 点扩展图标 → "打开查看器"，可拖入图片查看元数据

## 元数据字段说明

保存的图片同时写入以下字段：

### A1111 兼容字段

- **EXIF UserComment**（JPEG APP1，A1111 工具识别的入口）：
  ```
  正向提示词
  Negative prompt: 负向提示词
  Steps: 0, Sampler: Unknown, CFG scale: 0, Model: wenxin-assistant
  ```
  文心助手不暴露 steps/sampler/cfg，此处为占位值。

### 自定义字段（AIP\_*）

JPEG 把所有键合成一个 JSON 写入 COM 段（以 `AIP:` 开头），PNG 为每个键单独写  
一条 iTXt。当前实际写入：

- `AIP_PROMPT`：正向提示词
- `AIP_MODEL`：模型名称
- `AIP_SOURCE`：来源平台标识
- `AIP_CREATED_AT`：生成时间（ISO-8601）
- `AIP_TOOL` / `AIP_TOOL_VERSION`：本插件标识与版本
- `AIP_IMAGE_URL`：图片 URL
- `AIP_IMAGE_TYPE` / `AIP_WIDTH` / `AIP_HEIGHT` / `AIP_NEGATIVE_PROMPT`：  
  平台提供时才写入
- `AIP_SEED` / `sampler` / `steps` / `cfg`：预留字段，v0.1.0 暂未采集

## 验证元数据

用以下任一工具查看保存图片的元数据：

- **在线**：<https://exif.tools> 、 <https://xypher7.github.io/ai-image-metadata-editor>
- **命令行**：`exiftool -Comment 图片.jpg`（查看 COM 段）、  
  `exiftool -UserComment 图片.jpg`（查看 EXIF UserComment）
- **ComfyUI**：直接把图片拖入 ComfyUI 画布，若元数据格式正确会自动重建工作流

## 适配器架构

插件采用"核心引擎 + 平台适配器"架构：

- `src/core/metadata.ts`：通用元数据读写引擎（PNG / JPEG，WebP 支持计划在 v0.2.0）
- `src/adapters/<platform>/`：各平台专属的 DOM 定位与提示词提取逻辑
- `src/content.ts`：统一入口，按当前域名加载对应适配器

新增平台适配器只需在 `src/adapters/` 下新建目录，  
实现约定的接口即可，无需改动核心引擎。

（详细的适配器开发指南将在第二个平台接入后补充）

## 开发

```bash
npm install       # 安装依赖
npm run build     # 构建到 dist/
```

## 路线图

- [x] v0.1.0：文心助手适配器，PNG/JPEG 元数据读写
- [ ] v0.2.0：接入第二个平台（ChatGPT 或即梦）
- [ ] v0.3.0：抽离 core 为独立 npm 包，提供 MCP Server
- [ ] v0.4.0：发布到 Edge Add-ons / Chrome Web Store

## 许可

MIT License，见 [LICENSE](./LICENSE)

## 贡献

欢迎提交 Issue 和 Pull Request。  
平台适配器的开发指南将在 v0.2.0 后补充。
