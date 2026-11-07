# Atelier local

[English](README.md) | **简体中文** | [한국어](README.ko.md)

这是一款使用 HTML、CSS 和 JavaScript 编写的本地 GGUF 模型聊天与图像理解界面。界面在浏览器中运行，由一个轻量的 Node.js 服务管理 llama.cpp。无需 npm 第三方依赖，不加载远程资源，也不使用遥测或云端 API。

应用界面目前使用法语。下文保留相关按钮的法语名称，方便在界面中找到对应功能。

## 启动

运行环境：**Node.js 22 或更高版本**、较新的浏览器，以及**支持 Qwen3.5 和视觉输入的较新版 llama-server**及其原生库。请使用与操作系统、处理器架构和硬件匹配的构建版本。应用不会自动下载模型或安装依赖。

Windows：双击 **Lancer-Windows.cmd**。

Linux：

```sh
sh lancer-linux.sh
```

以下命令在两个系统上均可使用：

```sh
node server.mjs --open
```

在浏览器中打开 **http://127.0.0.1:8787**。请保持终端运行；按 `Ctrl+C` 可停止应用及其启动的推理引擎。如果浏览器没有自动打开，请手动输入该地址。端口 8787 必须空闲。

无需运行 `npm install`，也可以使用 `npm start` 启动。

## 配置文件路径

打开 **Configuration**（配置），填写三个文件的完整路径，然后点击 **Enregistrer**（保存）：

| 组件 | 原始模型版本的示例文件 |
|---|---|
| 推理引擎 | Windows 使用 `llama-server.exe`，Linux 使用 `llama-server` |
| Q6_K 模型 | [DeepSeek-V4-Pro-Qwen3.5-9B.Q6_K.gguf](https://huggingface.co/mradermacher/DeepSeek-V4-Pro-Qwen3.5-9B-GGUF/blob/main/DeepSeek-V4-Pro-Qwen3.5-9B.Q6_K.gguf) |
| FP16 视觉投影器 | [DeepSeek-V4-Pro-Qwen3.5-9B.mmproj-f16.gguf](https://huggingface.co/mradermacher/DeepSeek-V4-Pro-Qwen3.5-9B-GGUF/blob/main/DeepSeek-V4-Pro-Qwen3.5-9B.mmproj-f16.gguf) |

示例使用原始的 [Jackrong/DeepSeek-V4-Pro-Qwen3.5-9B](https://huggingface.co/Jackrong/DeepSeek-V4-Pro-Qwen3.5-9B) 版本。GGUF 文件位于[对应的量化模型仓库](https://huggingface.co/mradermacher/DeepSeek-V4-Pro-Qwen3.5-9B-GGUF/tree/main)。视觉投影器必须与模型匹配；仅使用文字聊天时，可将投影器路径留空。请保持推理引擎发行包中 DLL/SO 原生库的原有目录结构。

模型路径必须指向**文件本身**，而不是名称相似的文件夹。在 Windows 资源管理器中可使用“复制文件地址”或“复制为路径”；路径两侧的引号可以保留。Linux 通用路径示例：`/path/to/models/model.Q6_K.gguf`。

GGUF 文件不会上传到浏览器。文件路径保存在 `data/config.json` 中。源码发布包不包含个人配置文件。

某些 Qwen3.5 GGUF 导出文件在元数据中声明了 MTP 层，但并未包含该层的张量。应用会检查这一特定不匹配问题，并在可行时使用仅作用于内存的元数据覆盖。如果逐层元数据数组也包含这个缺失的层，应用会在 `data/model-cache` 中创建**兼容性副本**，修正元数据并保持权重的字节和存储位置不变。原始下载文件不会被修改。副本需要大约一个模型文件大小的额外磁盘空间，并会在后续启动时复用。实际包含 MTP 层的模型不会被修改。此机制不能修复缺失或损坏的模型权重。

部分 Ollama 安装所附带的 llama.cpp 引擎可以直接复用。应用会检测推理引擎旁 `cuda_v12` 或 `cuda_v13` 子目录中的 CUDA 库，不会启动或重新配置 Ollama 服务。如果环境中已经设置了 `GGML_BACKEND_PATH`，应用会保留该设置。

## 外观

界面默认为 **Night**（深色）模式。点击 Configuration 旁的 **Day / Night** 按钮可切换主题。选择会保存在本地 `data/preferences.json` 中，关闭或重启应用后仍然保留；该文件不会提交到 Git。聊天内容可以在悬浮按钮后方滚动，按钮始终可见。

## 聊天与图像

发送第一条消息时，应用会自动启动已配置的模型及其视觉投影器（如有）。消息会等待加载完成，然后仅发送一次。已配置投影器时，可以在启动前添加图片。取消等待会将文字和图片恢复到输入框，模型仍会继续加载；加载失败时也会保留消息。手动启动和停止按钮仍然可用。

- 输入消息后按 Enter 发送；Shift+Enter 换行。
- 点击图像按钮添加 PNG/JPEG 图片，也可以拖放到输入区域，或在消息输入框中粘贴图片。
- 每条消息最多包含三张图片，每个源文件不超过 10 MiB。图片会将最长边缩放至最多 2,048 像素，并以白色背景转换为 JPEG 后在本地传给引擎。单次对话请求的总大小上限为 20 MiB；如果历史图片过多，请新建对话。
- **Réflexion**（思考）通过模型的聊天模板请求开启或关闭推理。实际效果取决于模型。收到的推理内容会显示在独立、可折叠的区域中。
- 方形按钮用于中断当前回复，已收到的文字会保留。
- 每次回复默认最多生成 4,096 个 token，包含推理，可在 Sortie maximale 中调整；达到输出或上下文上限时会显示截断提示。
- 模型回复支持常用 Markdown：标题、段落、粗体、斜体、删除线、列表、引用、简单表格、链接、行内代码和围栏代码块。回复流式输出时会同步更新格式。模型生成的原始 HTML 会被转义，不安全的链接协议会被拒绝，图片嵌入语法不会加载远程图片。

历史保存关闭时，刷新或关闭页面会丢失对话。启用后，可从历史列表恢复消息和图片。Configuration 会保留文件路径；关闭页面不会自动卸载模型。使用 Arrêter le modèle 或停止服务器可释放模型。

## 可选对话历史与令牌限制

Configuration 中的 **Conserver les conversations**（保留对话）默认关闭。关闭时，行为与此前相同：刷新或关闭页面会丢失对话。开启后，消息、推理和浏览器压缩后的图片会保存在项目的 `history/<对话ID>/` 中：`conversation.json` 与图片文件分开保存，相同图片在重复保存时不会重复复制。`history/` 和 `data/` 均被 Git 忽略，手动上传源码时也应排除这两个目录。

可从侧边栏重新打开对话；窄屏可在 Configuration 中访问历史。应用会保存待处理消息、定期保存部分回复并保存最终回复。未完成发送的用户消息恢复为草稿，不会自动重发；部分助手回复会明确标注。强制关闭仍可能丢失最近尚未保存的流式内容。关闭历史只停止后续保存并隐藏列表，不会删除旧文件。对话中开启历史会保存当前交流；保存失败时仍保留页面内容，并阻止切换对话，直到保存成功或关闭历史。文件可在应用关闭后手动备份或删除。

**Contexte total**（总上下文）由消息、图像令牌、推理和回复共享；选项为 4,096 至 262,144。大上下文属于高级选项，实际容量取决于模型和内存/显存。**Sortie maximale**（最大输出）单独限制每次生成，包含推理，默认 4,096，最高可选 32,768 且不超过上下文。修改时需先停止模型，保存后在下次启动生效。恢复历史不会扩大模型上下文。

模型卡片边框用绿色表示就绪，红色表示停止或不可用，琥珀色表示加载或停止中。状态同时提供无障碍标签。

图片限制是**每条消息三张**，不是整个对话三张。现有处理为 JPEG 质量 `0.9`、最长边 2,048 像素；质量参数不等于压缩掉 90% 的体积，小型 PNG 截图转为 JPEG 甚至可能变大。历史保存处理后的原始字节，不会再次压缩。每次发送仍包含整个活动对话及旧图片，完整 JSON 请求上限为 20 MiB，Base64 约增加三分之一体积。JPEG 体积变小不会直接减少视觉令牌，图像尺寸和视觉编码器的处理方式才是关键。未更改图片数量限制，也未实现大量参考图或 Krea2 自动生成与比较功能。

## 内存与硬件

默认上下文为 **8,192 个 token**，并请求将所有可用模型层放到 GPU 上。初始配置面向 12 GB 显存的显卡，但实际占用取决于模型、上下文和图片。如果引擎报告内存或显存不足，请先停止引擎，再在 Configuration 中缩小上下文或减少 GPU 层数。

**CPU uniquement**（仅 CPU）使用处理器进行推理，并同时关闭视觉投影器的 GPU 卸载。速度可能明显较慢。应用面向 Windows/Linux，并不意味着所有计算机都有足够内存运行 9B 模型。没有 NVIDIA 显卡的计算机可使用 CPU 引擎，或适合自身 GPU 的 llama.cpp 构建版本。

应用不会执行或修改显卡解锁工具。目前已在 Windows 上进行本地运行验证；Linux 上的实际运行情况尚未验证。

## 故障排查

- **找不到文件：**检查完整路径，并确认下载已经完成。
- **引擎退出：**打开 Configuration → **Journaux du moteur**（引擎日志）。未知选项可能意味着引擎版本过旧；未知模型架构或不兼容的投影器需要匹配的引擎版本和模型文件。
- **无法检测到 CUDA：**检查引擎发行包、原生库和显卡驱动。设置 GPU 层数不代表一定会使用 GPU，实际卸载情况以引擎日志为准。
- **超出上下文：**新建对话，或在内存允许时增大上下文。应用不会静默删除历史消息。
- **连接中断：**检查终端后再刷新页面。本版本不持久化对话历史，刷新前请先复制需要保留的文字。
- **端口被占用：**可能已有其他实例使用 8787，请先关闭该实例再启动。

两个服务都只监听本机回环地址。控制接口会检查主机、来源和会话令牌。远程图片 URL 会被拒绝，llama.cpp 以离线模式启动，同时只允许一个生成请求。

## 冒烟测试

```sh
node --test tests/smoke.mjs tests/markdown.mjs tests/preferences.mjs tests/model-ready.mjs tests/history.mjs tests/limits.mjs
```

也可以运行 `npm run smoke`。测试使用单独放在 `tests/fixtures/` 中的**模拟 HTTP 引擎**，检查应用启动、配置、访问限制、文字与推理流、图像、取消生成、停止引擎、CUDA 库检测，以及缺失 MTP 层的兼容性处理。它不衡量真实模型的回答质量或速度。

## 参考与许可

- [llama.cpp](https://github.com/ggml-org/llama.cpp)
- [服务器与 API 文档](https://github.com/ggml-org/llama.cpp/tree/master/tools/server)
- [多模态输入文档](https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md)
- [源码发布说明](DISTRIBUTION.md)

推理引擎、模型和视觉投影器需单独提供，并保留各自的许可条款。
