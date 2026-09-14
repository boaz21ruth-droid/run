// Package db 内嵌数据库迁移文件与约束测试脚本，供迁移命令和测试使用。
package db

import "embed"

// Migrations 包含 migrations/*.sql（goose 格式）。
//
//go:embed migrations/*.sql
var Migrations embed.FS

// InvariantsSQL 是数据库约束测试脚本（为 psql 编写，首行含 psql 元命令）。
//
//go:embed tests/invariants_test.sql
var InvariantsSQL string
