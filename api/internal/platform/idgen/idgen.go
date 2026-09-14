// Package idgen 生成对外展示的业务编号（Crockford Base32）。
package idgen

import (
	"crypto/rand"
	"encoding/base32"
	"errors"

	"github.com/jackc/pgx/v5/pgconn"
)

const (
	PrefixOrder        = "WR"
	PrefixProof        = "PF"
	PrefixRegistration = "RG"
	PrefixFreeSignup   = "FS"
	PrefixException    = "EX"
)

const maxAttempts = 3

var crockford = base32.NewEncoding("0123456789ABCDEFGHJKMNPQRSTVWXYZ").WithPadding(base32.NoPadding)

// Code 返回 prefix + 8 位 Crockford Base32（40 位随机数）。
func Code(prefix string) string {
	var b [5]byte
	_, _ = rand.Read(b[:]) // crypto/rand.Read 不会返回错误
	return prefix + crockford.EncodeToString(b[:])
}

// TicketCode 返回 20 字节随机数的 Crockford Base32（32 位）。
func TicketCode() string {
	var b [20]byte
	_, _ = rand.Read(b[:])
	return crockford.EncodeToString(b[:])
}

// Retry 调用 fn 最多 3 次；fn 返回的错误是 PostgreSQL 唯一约束冲突（23505）且约束名等于
// constraint 时重试，否则原样返回。第 3 次仍冲突时返回最后一次的错误。
//
// 在事务里使用时，fn 必须在保存点（tx.Begin 得到的嵌套事务）内执行插入：
// 唯一冲突会让所在事务进入 aborted 状态，不用保存点的话重试一定失败。
func Retry(constraint string, fn func() error) error {
	var err error
	for range maxAttempts {
		err = fn()
		if !isUniqueViolation(err, constraint) {
			return err
		}
	}
	return err
}

func isUniqueViolation(err error, constraint string) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == constraint
}
