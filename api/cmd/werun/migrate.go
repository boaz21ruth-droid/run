package main

import (
	"context"
	"fmt"
	"io"

	"werun/api/internal/platform/migrate"
)

const migrateUsage = "usage: werun migrate up|down|status"

func runMigrate(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	if len(args) != 1 || (args[0] != "up" && args[0] != "down" && args[0] != "status") {
		fmt.Fprintln(stderr, migrateUsage)
		return 2
	}

	app, err := Bootstrap(ctx)
	if err != nil {
		fmt.Fprintf(stderr, "bootstrap: %v\n", err)
		return 1
	}
	defer app.Close()

	switch args[0] {
	case "up":
		err = migrate.Up(ctx, app.Pool, app.Log)
	case "down":
		err = migrate.Down(ctx, app.Pool, app.Log)
	case "status":
		var lines []string
		lines, err = migrate.Status(ctx, app.Pool)
		for _, line := range lines {
			fmt.Fprintln(stdout, line)
		}
	}
	if err != nil {
		fmt.Fprintf(stderr, "migrate %s: %v\n", args[0], err)
		return 1
	}
	return 0
}
