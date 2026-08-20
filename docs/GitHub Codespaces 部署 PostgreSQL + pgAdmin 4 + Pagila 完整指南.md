# GitHub Codespaces 部署 PostgreSQL + pgAdmin 4 + Pagila 完整指南

> 目标：完全通过浏览器，在 GitHub Codespaces 中运行 PostgreSQL + pgAdmin 4，并导入 Pagila 示例数据库，用于练习 SQL、数据库管理和 pgAdmin 4 功能。
>
> 推荐组合：
>
> - GitHub Codespaces
> - PostgreSQL 16
> - pgAdmin 4 9.17
> - Pagila 3.1.0
>
> 当前 GitHub Free 个人账号包含每月 **120 core-hours + 15 GB-month Codespaces 存储**。停止 Codespace 后不再消耗计算时间，但仍占用存储。

---

## 1. 创建 GitHub Codespace

打开：

https://github.com/codespaces

选择：

**Create codespace → Blank Template**

进入后就是浏览器里的 VS Code。

不需要本机安装 Docker。

---

# 2. 创建 Docker Compose 文件

在左侧资源管理器中创建：

```text
docker-compose.yml
```

内容直接使用下面这份：

```yaml
services:
  postgres:
    image: postgres:16-alpine
    container_name: postgres_db
    restart: unless-stopped

    environment:
      POSTGRES_USER: admin
      POSTGRES_PASSWORD: MyPassword123!
      POSTGRES_DB: demo_db

    ports:
      - "5432:5432"

    volumes:
      - pgdata:/var/lib/postgresql/data

  pgadmin:
    image: dpage/pgadmin4:9.17
    container_name: pgadmin_web
    restart: unless-stopped

    environment:
      PGADMIN_DEFAULT_EMAIL: admin@example.com
      PGADMIN_DEFAULT_PASSWORD: AdminPassword123!

      PGADMIN_CONFIG_SERVER_MODE: 'True'

      # GitHub Codespaces 反向代理相关
      PGADMIN_CONFIG_PROXY_X_FOR_COUNT: 1
      PGADMIN_CONFIG_PROXY_X_PROTO_COUNT: 1
      PGADMIN_CONFIG_PROXY_X_HOST_COUNT: 1

      # 避免 Codespaces HTTPS → 容器 HTTP 导致 Session 401
      PGADMIN_CONFIG_SESSION_COOKIE_SECURE: 'False'

    ports:
      - "5050:80"

    depends_on:
      - postgres

    volumes:
      - pgadmin_data:/var/lib/pgadmin

volumes:
  pgdata:
  pgadmin_data:
```

这里固定 pgAdmin `9.17`，避免以后 `dpage/pgadmin4` 标签自动升级导致实验环境发生变化。

pgAdmin 官方 Docker 文档支持通过 `PGADMIN_CONFIG_*` 环境变量注入配置，并提供 `PROXY_X_*` 参数处理反向代理。

---

# 3. 启动容器

打开 VS Code 下方：

**Terminal**

执行：

```bash
docker compose up -d
```

检查：

```bash
docker compose ps
```

正常情况下应该看到：

```text
postgres_db
pgadmin_web
```

再检查 PostgreSQL：

```bash
docker exec -it postgres_db psql -U admin -d demo_db -c "SHOW server_version;"
```

检查 pgAdmin：

```bash
docker exec pgadmin_web cat /pgadmin4/VERSION
```

---

# 4. 暴露 pgAdmin 端口

pgAdmin 容器内部使用：

```text
80
```

Docker 映射到了 Codespace：

```text
5050
```

在 VS Code 底部打开：

**PORTS**

如果没有自动出现 `5050`：

**Add Port → 5050**

GitHub Codespaces 会生成类似：

```text
https://xxxx-5050.app.github.dev
```

的地址。

GitHub 官方规定，Codespaces 的 forwarded port 默认是 **Private**，只有经过 GitHub 身份认证后才能访问；Public 则任何拿到 URL 的人都可以访问。

### 建议保持 Private

你的场景不需要真正公网访问。

访问：

```text
https://xxxx-5050.app.github.dev
```

时，**先登录 GitHub**。

然后才进入 pgAdmin 登录页。

---

# 5. 登录 pgAdmin

pgAdmin 登录信息：

```text
Email:
admin@example.com

Password:
AdminPassword123!
```

登录成功后应该看到 pgAdmin 4 主界面。

### 如果登录后整页黑屏

检查浏览器 F12 → Console。

如果看到：

```text
/preferences/get_all 401
/misc/bgprocess/ 401
/browser/check_corrupted_db_file 401
/llm/status 401
```

说明是 Codespaces 代理下的 Session / Forwarded Header 问题。

确认 Compose 中存在：

```yaml
PGADMIN_CONFIG_PROXY_X_FOR_COUNT: 1
PGADMIN_CONFIG_PROXY_X_PROTO_COUNT: 1
PGADMIN_CONFIG_PROXY_X_HOST_COUNT: 1
PGADMIN_CONFIG_SESSION_COOKIE_SECURE: 'False'
```

这是这套环境正常工作的关键配置。

---

# 6. 在 pgAdmin 中连接 PostgreSQL

此时 PostgreSQL 已经运行，但 pgAdmin 左侧还没有 Server。

在 pgAdmin：

```text
Servers
→ Register
→ Server
```

填写：

```text
Name:
Demo PostgreSQL
```

Connection：

```text
Host name/address:
postgres

Port:
5432

Maintenance database:
demo_db

Username:
admin

Password:
MyPassword123!
```

### Host 不要填 localhost

必须：

```text
postgres
```

原因是两个容器属于同一个 Docker Compose 网络：

```text
pgadmin
   ↓
postgres:5432
```

`postgres` 是 Compose service name。

---

# 7. 安装 Pagila 示例数据库

## 为什么选择 Pagila 3.1.0

当前 Pagila 主线已经进入 4.x，最新版本针对 PostgreSQL 18，并加入了更多 PostgreSQL 18 / pgvector / pg_partman 相关内容。

你当前使用 PostgreSQL 16，因此这里固定使用：

```text
Pagila v3.1.0
```

这是成熟的历史版本，包含：

- actor
- film
- category
- customer
- rental
- payment
- inventory
- store
- staff
- address
- city
- country
- language

以及 Views、Functions、Triggers、Foreign Keys、Partition 等数据库对象。

Pagila 3.1.0 的发布记录也明确包含 pgAdmin、Schema Diagram 和 Docker Compose 支持。

---

# 8. 下载 Pagila 3.1.0

在 Codespaces Terminal：

```bash
curl -O https://raw.githubusercontent.com/devrimgunduz/pagila/pagila-v3.1.0/pagila-schema.sql

curl -O https://raw.githubusercontent.com/devrimgunduz/pagila/pagila-v3.1.0/pagila-data.sql
```

检查文件：

```bash
ls -lh pagila-*.sql
```

---

# 9. 创建 pagila 数据库

执行：

```bash
docker exec -i postgres_db \
  psql -U admin -d demo_db \
  -c "CREATE DATABASE pagila;"
```

成功后导入 Schema：

```bash
docker exec -i postgres_db \
  psql -U admin -d pagila \
  < pagila-schema.sql
```

再导入数据：

```bash
docker exec -i postgres_db \
  psql -U admin -d pagila \
  < pagila-data.sql
```

Pagila 的标准安装流程就是创建数据库后依次导入 schema 和 data。

---

# 10. 验证 Pagila 是否安装成功

最简单：

```bash
docker exec -it postgres_db \
  psql -U admin -d pagila -c "\dt"
```

应该看到类似：

```text
 actor
 address
 category
 city
 country
 customer
 film
 film_actor
 film_category
 inventory
 language
 payment
 rental
 staff
 store
```

再检查表数量：

```bash
docker exec -it postgres_db \
  psql -U admin -d pagila \
  -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';"
```

---

# 11. 在 pgAdmin 中打开 Pagila

回到 pgAdmin：

```text
Servers
└── Demo PostgreSQL
    └── Databases
        ├── demo_db
        └── pagila
```

展开：

```text
pagila
├── Schemas
│   └── public
│       ├── Tables
│       ├── Views
│       ├── Functions
│       └── Sequences
```

此时就可以使用 pgAdmin 的 Query Tool：

```text
右键 pagila
→ Query Tool
```

例如：

```sql
SELECT *
FROM film
LIMIT 20;
```

多表 JOIN：

```sql
SELECT
    f.title,
    c.name AS category
FROM film f
JOIN film_category fc
    ON fc.film_id = f.film_id
JOIN category c
    ON c.category_id = fc.category_id
ORDER BY f.title;
```

---

# 12. 以后重新使用

不需要重新创建环境。

启动 Codespace 后：

```bash
docker compose up -d
```

然后打开：

```text
PORTS
→ 5050
→ Forwarded Address
```

进入 pgAdmin 即可。

如果容器已经存在，也可以检查：

```bash
docker compose ps
```

---

# 13. 用完以后怎么停止，节省 Codespaces 免费额度

不要直接关闭浏览器。

正确做法：

```text
GitHub
→ Codespaces
→ 找到当前 Codespace
→ Stop codespace
```

或者在 VS Code：

```text
Ctrl + Shift + P
→ Codespaces: Stop Codespace
```

GitHub Free 当前每月包含：

```text
120 core-hours
15 GB-month storage
```

停止 Codespace 后不再消耗计算时间，但 Codespace 存储仍然占用存储额度。

### 不要使用

```bash
docker compose down -v
```

因为 `-v` 会删除：

```text
pgdata
pgadmin_data
```

也就是：

```text
PostgreSQL 数据
+
pgAdmin 数据
```

都会被删除。

普通停止 Codespace 不会删除这些 Docker volume。

---

# 14. 如果确定长期不用

可以删除整个 Codespace：

```text
GitHub
→ Codespaces
→ ...
→ Delete
```

这样可以释放 Codespaces 存储。

但删除后：

```text
PostgreSQL 数据 ❌
pgAdmin 数据 ❌
容器环境状态 ❌
```

都会消失。

所以日常建议：

```text
暂时不用
    ↓
Stop Codespace

长期不用
    ↓
Delete Codespace
```

---

# 15. 最终结构

整个环境最终是：

```text
GitHub Codespaces
│
├── Docker
│
├── PostgreSQL 16
│   └── pagila
│       ├── film
│       ├── actor
│       ├── customer
│       ├── rental
│       ├── payment
│       ├── inventory
│       ├── category
│       └── ...
│
└── pgAdmin 4.17
    │
    └── :5050
          ↓
    GitHub Codespaces Port Forward
          ↓
    浏览器
```

其中真正需要记住的只有几个参数：

```text
PostgreSQL
Host: postgres
Port: 5432
User: admin
Password: MyPassword123!

pgAdmin
URL: Codespaces 转发的 5050
Email: admin@example.com
Password: AdminPassword123!

Database
pagila
```

---

## 16. 一套完整的检查命令

以后环境出现问题，可以按这个顺序检查：

```bash
# 1. 容器
docker compose ps

# 2. PostgreSQL 版本
docker exec postgres_db psql -U admin -d demo_db \
  -c "SHOW server_version;"

# 3. pgAdmin 版本
docker exec pgadmin_web cat /pgadmin4/VERSION

# 4. 数据库
docker exec postgres_db psql -U admin -d demo_db \
  -c "\l"

# 5. Pagila 表
docker exec postgres_db psql -U admin -d pagila \
  -c "\dt"

# 6. pgAdmin 日志
docker logs pgadmin_web --tail 100

# 7. PostgreSQL 日志
docker logs postgres_db --tail 100
```

### 最终推荐状态

```text
GitHub Codespace
    ↓
docker compose up -d
    ↓
PostgreSQL 16
    ↓
Pagila 3.1.0
    ↓
pgAdmin 4.9.17
    ↓
Port 5050 / Private
    ↓
GitHub 身份认证
    ↓
浏览器访问
```

这套配置适合作为一个长期保留的个人 PostgreSQL / pgAdmin 实验环境。