import { Link, Outlet } from '@tanstack/react-router';
import { TanStackRouterDevtools } from '@tanstack/router-devtools';
import { Backdrop } from '@/components/backdrop/backdrop';
import { BackdropProvider } from '@/components/backdrop/backdrop-context';
import { BackdropPicker } from '@/components/backdrop/backdrop-picker';
import { SpriteStylePicker } from '@/components/sprite-style-picker';
import { TooltipProvider } from '@/components/ui/tooltip';

function App() {
    return (
        <BackdropProvider>
        <TooltipProvider delayDuration={150}>
        <Backdrop />
        <div className="min-h-screen flex flex-col">
            <header className="border-b">
                <div className="flex items-center gap-6 px-6 py-4">
                    <h1 className="text-lg font-semibold">Pokemon Champions</h1>
                    <nav className="flex flex-1 gap-4 text-sm">
                        <Link
                            to="/"
                            className="text-muted-foreground hover:text-foreground [&.active]:text-foreground [&.active]:font-medium"
                        >
                            Home
                        </Link>
                        <Link
                            to="/types"
                            className="text-muted-foreground hover:text-foreground [&.active]:text-foreground [&.active]:font-medium"
                        >
                            Types
                        </Link>
                        <Link
                            to="/pokemon"
                            className="text-muted-foreground hover:text-foreground [&.active]:text-foreground [&.active]:font-medium"
                        >
                            Pokemon
                        </Link>
                        <Link
                            to="/teams"
                            className="text-muted-foreground hover:text-foreground [&.active]:text-foreground [&.active]:font-medium"
                        >
                            Teams
                        </Link>
                        <Link
                            to="/calc"
                            className="text-muted-foreground hover:text-foreground [&.active]:text-foreground [&.active]:font-medium"
                        >
                            Calc
                        </Link>
                        <Link
                            to="/prep"
                            className="text-muted-foreground hover:text-foreground [&.active]:text-foreground [&.active]:font-medium"
                        >
                            Prep
                        </Link>
                        <Link
                            to="/speed-tiers"
                            className="text-muted-foreground hover:text-foreground [&.active]:text-foreground [&.active]:font-medium"
                        >
                            Speed tiers
                        </Link>
                        <Link
                            to="/analyzer"
                            className="text-muted-foreground hover:text-foreground [&.active]:text-foreground [&.active]:font-medium"
                        >
                            Analyzer
                        </Link>
                        <Link
                            to="/scan"
                            className="text-muted-foreground hover:text-foreground [&.active]:text-foreground [&.active]:font-medium"
                        >
                            Scan
                        </Link>
                        <Link
                            to="/battle"
                            className="text-muted-foreground hover:text-foreground [&.active]:text-foreground [&.active]:font-medium"
                        >
                            Battle
                        </Link>
                        <Link
                            to="/coach"
                            className="text-muted-foreground hover:text-foreground [&.active]:text-foreground [&.active]:font-medium"
                        >
                            Coach
                        </Link>
                        <Link
                            to="/matchups"
                            className="text-muted-foreground hover:text-foreground [&.active]:text-foreground [&.active]:font-medium"
                        >
                            Matchups
                        </Link>
                    </nav>
                    <SpriteStylePicker />
                    <BackdropPicker />
                </div>
            </header>
            <main className="flex-1">
                <Outlet />
            </main>
            <TanStackRouterDevtools />
        </div>
        </TooltipProvider>
        </BackdropProvider>
    );
}

export default App;
