package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"

	"golang.org/x/term"

	"werun/api/internal/iam"
	"werun/api/internal/platform/apperr"
	"werun/api/internal/platform/i18n"
)

// runCreateStaff 实现 `werun create-staff`。
func runCreateStaff(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("create-staff", flag.ContinueOnError)
	username := fs.String("username", "", "登录名：3–64 位小写字母、数字、点、下划线或连字符")
	fullName := fs.String("full-name", "", "员工姓名")
	roleName := fs.String("role", "", "角色："+roleList())
	passwordStdin := fs.Bool("password-stdin", false, "从标准输入读取密码（CI 与脚本使用）")
	if err := fs.Parse(args); err != nil {
		return err
	}
	role, ok := iam.ParseRole(*roleName)
	if !ok {
		return fmt.Errorf("--role 必须是以下之一：%s", roleList())
	}

	var password string
	var err error
	if *passwordStdin {
		password, err = readPasswordLine(os.Stdin)
	} else {
		password, err = promptPassword(os.Stdin, os.Stderr)
	}
	if err != nil {
		return err
	}

	app, err := Bootstrap(ctx)
	if err != nil {
		return err
	}
	defer app.Close()

	staff, err := app.IAM.CreateStaff(ctx, *username, *fullName, role, password)
	if err != nil {
		return describeError(app.Catalog, err)
	}
	fmt.Fprintf(os.Stdout, "已创建员工 id=%d username=%s role=%s\n", staff.ID, staff.Username, staff.Role)
	return nil
}

func roleList() string {
	names := make([]string, len(iam.AllRoles))
	for i, r := range iam.AllRoles {
		names[i] = string(r)
	}
	return strings.Join(names, ", ")
}

// readPasswordLine 读取第一行作为密码，去掉行尾换行。
func readPasswordLine(r io.Reader) (string, error) {
	line, err := bufio.NewReader(r).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", fmt.Errorf("读取密码失败: %w", err)
	}
	password := strings.TrimRight(line, "\r\n")
	if password == "" {
		return "", errors.New("标准输入中没有密码")
	}
	return password, nil
}

// promptPassword 在终端里不回显地输入两次密码。
func promptPassword(in *os.File, out io.Writer) (string, error) {
	fd := int(in.Fd())
	if !term.IsTerminal(fd) {
		return "", errors.New("当前不是交互式终端，请改用 --password-stdin")
	}
	fmt.Fprint(out, "密码: ")
	first, err := term.ReadPassword(fd)
	fmt.Fprintln(out)
	if err != nil {
		return "", err
	}
	fmt.Fprint(out, "再次输入密码: ")
	second, err := term.ReadPassword(fd)
	fmt.Fprintln(out)
	if err != nil {
		return "", err
	}
	if string(first) != string(second) {
		return "", errors.New("两次输入的密码不一致")
	}
	return string(first), nil
}

// describeError 把业务错误渲染成中文提示，列出每个出错字段。
func describeError(cat *i18n.Catalog, err error) error {
	appErr, ok := apperr.As(err)
	if !ok {
		return err
	}
	msg := cat.T(i18n.ZH, appErr.Code, appErr.Params)
	if len(appErr.Fields) == 0 {
		return errors.New(msg)
	}
	fields := make([]string, 0, len(appErr.Fields))
	for name, fe := range appErr.Fields {
		fields = append(fields, fmt.Sprintf("%s: %s", name, cat.T(i18n.ZH, fe.Key, fe.Params)))
	}
	sort.Strings(fields)
	return fmt.Errorf("%s（%s）", msg, strings.Join(fields, "；"))
}
