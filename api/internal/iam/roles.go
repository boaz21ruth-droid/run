package iam

// Role 是后台员工角色，与 staff.role 的 CHECK 约束一致。
type Role string

const (
	RoleAdmin          Role = "ADMIN"
	RoleOps            Role = "OPS"
	RoleFinance        Role = "FINANCE"
	RoleSupport        Role = "SUPPORT"
	RoleRaceSupervisor Role = "RACE_SUPERVISOR"
	RoleRaceStaff      Role = "RACE_STAFF"
	RolePhotographer   Role = "PHOTOGRAPHER"
)

// AllRoles 的顺序与 Demo 权限矩阵的列顺序一致。
var AllRoles = []Role{
	RoleAdmin,
	RoleOps,
	RoleFinance,
	RoleSupport,
	RoleRaceSupervisor,
	RoleRaceStaff,
	RolePhotographer,
}

// ParseRole 只接受大写的完整角色名。
func ParseRole(s string) (Role, bool) {
	for _, r := range AllRoles {
		if string(r) == s {
			return r, true
		}
	}
	return "", false
}

// Access 是某个角色对某个权限的访问级别。
type Access string

const (
	AccessRead  Access = "read"
	AccessWrite Access = "write"
)
