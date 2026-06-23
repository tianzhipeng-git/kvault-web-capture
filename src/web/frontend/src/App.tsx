import { useEffect, useState } from "react";
import { Routes, Route, Link, useLocation, useNavigate } from "react-router-dom";
import { FolderKanban, Settings, LogOut, ChevronLeft, ChevronRight } from "lucide-react";
import { api } from "./lib/api";
import { Projects } from "./pages/Projects";
import { ProjectDetails } from "./pages/ProjectDetails";
import { SiteDashboard } from "./pages/SiteDashboard";
import { Login } from "./pages/Login";
import { Settings as SettingsPage } from "./pages/Settings";
import { Button } from "./components/ui/button";

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    return localStorage.getItem("sidebarCollapsed") === "true";
  });

  const toggleSidebar = () => {
    setSidebarCollapsed((prev) => {
      localStorage.setItem("sidebarCollapsed", String(!prev));
      return !prev;
    });
  };

  useEffect(() => {
    if (location.pathname === "/login") {
      setIsCheckingAuth(false);
      return;
    }

    api.getSession()
      .then((res) => {
        if (!res.authenticated) {
          navigate("/login", { replace: true });
        }
      })
      .catch(() => {
        // Will be handled by fetchApi 401 interceptor if unauthorized
        // Or if backend is down, we just stay and show error later
      })
      .finally(() => {
        setIsCheckingAuth(false);
      });
  }, [location.pathname, navigate]);

  const handleLogout = async () => {
    await api.logout();
    navigate("/login", { replace: true });
  };

  if (isCheckingAuth) {
    return <div className="min-h-screen flex items-center justify-center">Loading...</div>;
  }

  if (location.pathname === "/login") {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
      </Routes>
    );
  }

  const navItems = [
    { name: "项目管理", path: "/", icon: FolderKanban },
    { name: "系统设置", path: "/settings", icon: Settings },
  ];

  return (
    <div className="min-h-screen flex bg-background">
      {/* Sidebar */}
      <aside className={`${sidebarCollapsed ? "w-16" : "w-64"} border-r bg-card/50 backdrop-blur supports-[backdrop-filter]:bg-background/60 flex flex-col relative z-10 transition-all duration-300`}>
        <div className={`p-4 flex items-center ${sidebarCollapsed ? "justify-center" : "gap-3"}`}>
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center text-primary-foreground font-bold shrink-0">
            Cap
          </div>
          {!sidebarCollapsed && (
            <span className="font-semibold text-lg tracking-tight truncate">Kvault Capture</span>
          )}
        </div>

        <nav className="px-2 space-y-1 flex-1">
          {navItems.map((item) => (
            <Link
              key={item.path}
              to={item.path}
              title={sidebarCollapsed ? item.name : undefined}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-md transition-colors ${sidebarCollapsed ? "justify-center" : ""} ${location.pathname === item.path || (item.path !== '/' && location.pathname.startsWith(item.path))
                ? "bg-primary text-primary-foreground font-medium shadow-sm"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
            >
              <item.icon className="w-5 h-5 shrink-0" />
              {!sidebarCollapsed && item.name}
            </Link>
          ))}
        </nav>

        <div className={`p-2 border-t space-y-1`}>
          <Button
            variant="ghost"
            className={`w-full text-muted-foreground hover:text-foreground ${sidebarCollapsed ? "justify-center px-0" : "justify-start gap-3"}`}
            title={sidebarCollapsed ? "退出登录" : undefined}
            onClick={handleLogout}
          >
            <LogOut className="w-5 h-5 shrink-0" />
            {!sidebarCollapsed && "退出登录"}
          </Button>
          <Button
            variant="ghost"
            className={`w-full text-muted-foreground hover:text-foreground ${sidebarCollapsed ? "justify-center px-0" : "justify-start gap-3"}`}
            onClick={toggleSidebar}
            title={sidebarCollapsed ? "展开侧边栏" : "折叠侧边栏"}
          >
            {sidebarCollapsed ? <ChevronRight className="w-5 h-5 shrink-0" /> : <><ChevronLeft className="w-5 h-5 shrink-0" /><span>折叠侧边栏</span></>}
          </Button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto bg-muted/20">
        <div className="p-8 max-w-screen-2xl mx-auto min-h-full">
          <Routes>
            <Route path="/" element={<Projects />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/projects/:projectId" element={<ProjectDetails />} />
            <Route path="/sites/:siteId/*" element={<SiteDashboard />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}
