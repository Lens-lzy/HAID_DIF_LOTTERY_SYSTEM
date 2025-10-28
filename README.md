# 🎁 HAID DIF Lottery System

> **2025 海大集团数智节现场抽奖系统**

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20+-green?logo=node.js" alt="Node.js">
  <img src="https://img.shields.io/badge/PM2-managed-blue?logo=pm2" alt="PM2">
  <img src="https://img.shields.io/badge/SQLite-lightgrey?logo=sqlite" alt="SQLite">
  <img src="https://img.shields.io/badge/license-MIT-orange" alt="License: MIT">
</p>

<p align="center">
  <b>轻量级实时抽奖系统 · 双端共享奖池 · 动态概率调节 · 自定义登录背景</b><br/>
  适用于年会、展会、节日活动等场景
</p>

---

## 📋 目录

- [🚀 功能概览](#-功能概览)
- [🧩 技术栈](#-技术栈)
- [📂 项目结构](#-项目结构)
- [⚙️ 安装与启动](#️-安装与启动)
- [☁️ 云端部署（推荐）](#️-云端部署推荐)
- [🔐 登录信息](#-登录信息)
- [🧠 抽奖规则简述](#-抽奖规则简述)
- [🧾 数据与备份](#-数据与备份)
- [🎨 登录页自定义](#-登录页自定义)
- [🛠️ 常见问题](#️-常见问题)
- [📜 License](#-license)
- [💬 致谢](#-致谢)

---

## 🚀 功能概览

| 模块 | 功能说明 |
|------|-----------|
| 🧑‍💼 **管理端（Admin）** | 登录后配置奖项数量、概率参数、活动时间等；查看实时库存与中奖名单 |
| 👷 **工作端（Staff）** | 输入姓名与工号、抽取多个结果后单选确认；系统自动扣减库存并锁定工号 |
| ⚙️ **核心算法** | 双层稳态 + 节奏控制（前高后平），动态平衡中奖概率 |
| 💾 **数据存储** | SQLite 数据库 + 自动备份（WAL 模式） |
| 📡 **部署** | 支持本地、内网穿透、云端（PM2/Nginx） |

---

## 🧩 技术栈

- **Backend:** Node.js + Express + Socket.IO + SQLite (better-sqlite3)
- **Frontend:** HTML + 原生 JavaScript + CSS（无框架，纯静态）
- **Deployment:** PM2 + Ubuntu + Nginx (可选)

---

## 📂 项目结构

```bash
HAID_DIF_lottery/
├── server.js              # 主服务端入口（Express + Socket + API）
├── package.json           # 依赖与脚本配置
├── public/
│   ├── admin.html         # 管理端网页
│   ├── staff.html         # 工作端网页
│   ├── assets/
│   │   └── bg.jpg         # 登录页背景图
│   └── style/             # 样式扩展（可选）
├── lottery.db             # SQLite 数据库文件
└── backups/               # 自动备份目录
```bash

---

## ☎ 联系方式

- 如果有任何使用上的问题，请直接联系我的邮箱：**stevenleo@gmail.com**


