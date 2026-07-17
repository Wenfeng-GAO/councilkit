# Execution Profile 不接受任意命令

Execution Profile 只能选择受支持的 Runtime Driver、引用 Runtime Host 已确认的 Runtime Installation，并填写该 Driver 声明的类型化配置；Runtime Host 负责解析本机程序、构造固定协议参数和受控环境，不允许 Profile 或导入文件提供任意 executable、原始 argv、Shell 片段或环境变量。Installation 只能通过 Host 本机发现或用户显式选择后验证建立；导入数据不能授予程序信任，找不到兼容 Installation 的 Profile 保持待绑定状态。协议 Driver、本机 Installation 和用户 Profile 保持独立；我们接受较低的自定义灵活性，以避免将设置页和配置导入变成本机任意代码执行入口。未来若支持自定义命令，必须作为独立、显式授权的 unsafe 能力设计。
