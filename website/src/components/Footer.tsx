export default function Footer() {
  return (
    <footer className="border-t border-border py-12">
      <div className="mx-auto flex max-w-5xl flex-col items-center gap-6 px-6 sm:flex-row sm:justify-between">
        <div className="flex items-center gap-6">
          <a
            href="https://github.com/getplumb/plumb"
            className="text-sm text-text-muted transition-colors hover:text-text-secondary"
          >
            GitHub
          </a>
          <a
            href="https://docs.getplumb.dev"
            className="text-sm text-text-muted transition-colors hover:text-text-secondary"
          >
            Docs
          </a>
          <a
            href="/privacy"
            className="text-sm text-text-muted transition-colors hover:text-text-secondary"
          >
            Privacy
          </a>
          <a
            href="/terms"
            className="text-sm text-text-muted transition-colors hover:text-text-secondary"
          >
            Terms
          </a>
        </div>
        <p className="text-xs text-text-muted">
          &copy; {new Date().getFullYear()} Plumb. All rights reserved.
        </p>
      </div>
    </footer>
  );
}
