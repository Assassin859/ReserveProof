import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";

/** Bento layout adapted from Magic UI / Aceternity (MIT). */
export function BentoGrid({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("grid auto-rows-[minmax(11rem,auto)] grid-cols-1 gap-4 md:grid-cols-3", className)}>{children}</div>;
}

export function BentoCard({
  title,
  description,
  href,
  icon,
  cta,
  className,
  children,
  external,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  href?: string;
  icon?: React.ReactNode;
  cta?: string;
  className?: string;
  children?: React.ReactNode;
  external?: boolean;
}) {
  const body = (
    <>
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(600px_circle_at_var(--x,50%)_0%,rgba(196,163,90,0.10),transparent_45%)] opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
      <div className="relative flex h-full flex-col">
        <div className="flex items-start justify-between gap-3">
          {icon && (
            <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
              {icon}
            </span>
          )}
          {href && (
            <ArrowUpRight className="h-4 w-4 text-muted-foreground transition-all duration-300 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-primary" />
          )}
        </div>
        <h3 className="mt-4 font-display text-lg font-semibold tracking-tight">{title}</h3>
        {description && <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{description}</p>}
        {children && <div className="mt-4 flex-1">{children}</div>}
        {cta && <span className="mt-4 text-sm font-medium text-primary">{cta} →</span>}
      </div>
    </>
  );
  const cls = cn(
    "group relative overflow-hidden rounded-xl border border-border/70 bg-card/70 p-5 transition-colors duration-300 hover:border-primary/40",
    className
  );
  if (!href) return <div className={cls}>{body}</div>;
  if (external || href.startsWith("http"))
    return (
      <a href={href} target="_blank" rel="noreferrer" className={cls}>
        {body}
      </a>
    );
  return (
    <Link href={href} className={cls}>
      {body}
    </Link>
  );
}
