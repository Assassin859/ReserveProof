import { cn } from "@/lib/utils";
import { Spotlight } from "../fx/Spotlight";

export function PageHeader({
  eyebrow,
  title,
  lede,
  actions,
  className,
  children,
}: {
  eyebrow: string;
  title: React.ReactNode;
  lede?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <header className={cn("relative overflow-hidden border-b border-border/50", className)}>
      <Spotlight className="-top-40 left-0 md:-top-20 md:left-40" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(196,163,90,0.08),transparent_60%)]" />
      <div className="container relative py-12 md:py-16">
        <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-primary">{eyebrow}</p>
        <h1 className="max-w-4xl font-display text-4xl font-semibold leading-[1.08] tracking-tight md:text-5xl">{title}</h1>
        {lede && <div className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground md:text-lg">{lede}</div>}
        {actions && <div className="mt-6 flex flex-wrap gap-2">{actions}</div>}
        {children}
      </div>
    </header>
  );
}

export function Section({
  id,
  kicker,
  title,
  description,
  actions,
  className,
  children,
}: {
  id?: string;
  kicker?: React.ReactNode;
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <section id={id} className={cn("scroll-mt-20", className)}>
      {(kicker || title || description || actions) && (
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div className="max-w-3xl">
            {kicker && <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-primary">{kicker}</p>}
            {title && <h2 className="font-display text-2xl font-semibold tracking-tight md:text-3xl">{title}</h2>}
            {description && <div className="mt-2 text-sm leading-relaxed text-muted-foreground md:text-base">{description}</div>}
          </div>
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Muted({ className, children }: { className?: string; children: React.ReactNode }) {
  return <span className={cn("text-muted-foreground", className)}>{children}</span>;
}

export function ExtLink({ href, className, children }: { href: string; className?: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={cn("text-primary underline-offset-4 hover:underline", className)}>
      {children}
    </a>
  );
}
