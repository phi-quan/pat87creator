import Link from 'next/link';

export default function HomePage() {
  return (
    <main>
      <h1>pat87creator MVP</h1>
      <p>
        <Link href="/dashboard">Go to dashboard</Link>
      </p>
      <p>
        <Link href="/signup">Create an account</Link>
      </p>
      <p>
        <Link href="/login">Log in</Link>
      </p>
    </main>
  );
}
